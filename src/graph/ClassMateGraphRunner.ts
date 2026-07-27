import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import type { LLMMessage } from '../llm/types';
import { AnswerPromptBuilder } from '../prompts/answerPromptBuilder';
import { preclassifyRequest } from '../prompts/intentRouter';
import { RouteAndPlanPromptBuilder } from '../prompts/routeAndPlanPromptBuilder';
import { assembleSkillContext } from '../skill/skillContextAssembler';
import { buildCompactSkillCatalog } from '../skill/skillCatalogBuilder';
import type { SkillContentLoader } from '../skill/skillContentLoader';
import type { SkillGraphLoader } from '../skill/skillGraphLoader';
import { retrieveSkillCandidates } from '../skill/skillGraphRetriever';
import type { SkillSectionExtractor } from '../skill/skillSectionExtractor';
import type { SkillCandidate } from '../skill/types';
import type { WorkspaceContextLoader } from '../workspace/workspaceContextLoader';
import type { WorkspaceContextProvider } from '../workspace/workspaceContextProvider';
import { buildWorkspaceSnapshot } from '../workspace/workspaceSnapshotBuilder';
import { getTaskDefinition } from './taskRegistry';
import {
	buildLearnerState,
	fallbackPlan,
	inferConcepts,
	sanitizePlannerResult,
	validateStudentAnswer,
} from './planning';
import { parseJsonObject, routeAndPlanWireSchema } from './schemas';
import type {
	ClassMateGraphState,
	ClassMateRequest,
	ContextRequest,
	GraphNodeTiming,
	InitialRoute,
	RequestType,
	RouteAndPlanResult,
} from './types';
import type { GraphModelClient } from './modelClient';

const MAX_ANSWER_RETRIES = 1;

export interface ClassMateGraphServices {
	workspaceProvider: WorkspaceContextProvider;
	workspaceLoader: WorkspaceContextLoader;
	skillContentLoader: SkillContentLoader;
	skillGraphLoader: SkillGraphLoader;
	skillSectionExtractor: SkillSectionExtractor;
	model: GraphModelClient;
	signal?: AbortSignal;
	onAnswerToken?: (token: string) => void;
	onProgress?: (node: string, message: string) => void;
	onDebug?: (event: string, data: unknown) => void;
}

export interface ClassMateGraphResult {
	answer: string;
	state: ClassMateGraphState;
	totalDurationMs: number;
	nodeTimings: GraphNodeTiming[];
}

interface WrappedState {
	value: ClassMateGraphState;
}

const GraphState = Annotation.Root({
	value: Annotation<ClassMateGraphState>(),
});

const NODE_PROGRESS_MESSAGES: Readonly<Record<string, string>> = {
	prepare: '正在扫描工作区…',
	route_and_plan: '正在判断问题并规划回答…',
	load_context: '正在读取所需文件…',
	freeze_route: '正在确认任务类型…',
	retrieve_skill: '正在查找相关知识…',
	freeze_context: '正在整理回答所需内容…',
	build_answer_prompt: '正在组织回答材料…',
	answer: '正在等待模型生成回答…',
	validate: '正在检查回答…',
};

function nextState(current: WrappedState, patch: Partial<ClassMateGraphState>): WrappedState {
	return { value: { ...current.value, ...patch } };
}

function contextRequestKey(request: ContextRequest): string {
	return [
		request.source,
		request.target.trim().replace(/\\/g, '/').toLowerCase(),
		request.section?.trim().toLowerCase() ?? '',
	].join('|');
}

/**
 * 找出用户明确点名的工作区文件。
 * 即使规划模型漏选，运行时也会加载该文件，避免无源码猜测。
 */
export function findExplicitWorkspaceRequests(
	userText: string,
	files: Array<{ path: string }>
): ContextRequest[] {
	const normalizedText = userText.toLowerCase().replace(/\\/g, '/');
	return files.flatMap((file) => {
		const normalizedPath = file.path.toLowerCase().replace(/\\/g, '/');
		const fileName = normalizedPath.split('/').pop() ?? normalizedPath;
		if (!fileName || !normalizedText.includes(fileName)) {
			return [];
		}
		return [{
			source: 'workspace' as const,
			target: file.path,
			required: true,
			reason: 'The user explicitly named this workspace file.',
		}];
	});
}

function enforceRouteLock(initial: InitialRoute, proposed: RequestType): RequestType {
	if (initial.lockPolicy === 'fully-locked' || initial.lockPolicy === 'family-locked') {
		return initial.requestType;
	}
	return proposed;
}

function uniqueContextRequests(requests: ContextRequest[]): ContextRequest[] {
	const seen = new Set<string>();
	return requests.filter((request) => {
		const key = contextRequestKey(request);
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		return true;
	});
}

function findDefaultWorkspaceRequests(
	requestType: RequestType,
	state: ClassMateGraphState
): ContextRequest[] {
	const workspace = state.minimalWorkspaceContext;
	if (!workspace) {
		return [];
	}
	const requests: ContextRequest[] = [];
	const questionTypes: RequestType[] = [
		'problem_understanding',
		'problem_hint',
		'solution_request',
	];
	const activeCodeTypes: RequestType[] = [
		'code_explanation',
		'compile_error_help',
		'runtime_error_help',
		'wrong_output_help',
		'oj_failure_help',
		'code_edit',
	];
	if (questionTypes.includes(requestType) && workspace.questionFile) {
		requests.push({
			source: 'workspace',
			target: workspace.questionFile,
			required: true,
			reason: 'The selected problem statement is required for this task type.',
		});
	}
	const activeFile = workspace.catalog.activeEditor?.fileName;
	if (activeCodeTypes.includes(requestType) && activeFile) {
		requests.push({
			source: 'workspace',
			target: activeFile,
			required: true,
			reason: 'The active source file is required for this task type.',
		});
	}
	return requests;
}

export class ClassMateGraphRunner {
	constructor(private readonly _services: ClassMateGraphServices) {}

	public async run(request: ClassMateRequest): Promise<ClassMateGraphResult> {
		const graphStartedAt = Date.now();
		const initial: ClassMateGraphState = {
			request,
			requestTypeFrozen: false,
			answerContextFrozen: false,
			routeAndPlanAttemptCount: 0,
			processedContextRequestKeys: [],
			loadedWorkspaceItems: [],
			skillCandidates: [],
			retrievedSkillSections: [],
			skillRequests: [],
			retrievalDegraded: false,
			answerMessages: [],
			answerRetryCount: 0,
			nodeTimings: [],
		};

		const graph = new StateGraph(GraphState)
			.addNode('prepare', (state) =>
				this._measureNode('prepare', state, () => this._prepare(state)))
			.addNode('route_and_plan', (state) =>
				this._measureNode('route_and_plan', state, () => this._routeAndPlan(state)))
			.addNode('load_context', (state) =>
				this._measureNode('load_context', state, () => this._loadContext(state)))
			.addNode('freeze_route', (state) =>
				this._measureNode('freeze_route', state, () => this._freezeRoute(state)))
			.addNode('retrieve_skill', (state) =>
				this._measureNode('retrieve_skill', state, () => this._retrieveSkill(state)))
			.addNode('freeze_context', (state) =>
				this._measureNode('freeze_context', state, () => this._freezeContext(state)))
			.addNode('build_answer_prompt', (state) =>
				this._measureNode('build_answer_prompt', state, () => this._buildAnswerPrompt(state)))
			.addNode('answer', (state) =>
				this._measureNode('answer', state, () => this._answer(state)))
			.addNode('validate', (state) =>
				this._measureNode('validate', state, () => this._validate(state)))
			.addEdge(START, 'prepare')
			.addEdge('prepare', 'route_and_plan')
			.addEdge('route_and_plan', 'load_context')
			.addEdge('load_context', 'freeze_route')
			.addEdge('freeze_route', 'retrieve_skill')
			.addEdge('retrieve_skill', 'freeze_context')
			.addEdge('freeze_context', 'build_answer_prompt')
			.addEdge('build_answer_prompt', 'answer')
			.addEdge('answer', 'validate')
			.addConditionalEdges('validate', (state) =>
				state.value.answerValidation?.shouldRegenerate
					&& !this._services.onAnswerToken
					&& state.value.answerRetryCount <= MAX_ANSWER_RETRIES
					? 'answer'
					: END
			)
			.compile();

		const output = await graph.invoke({ value: initial });
		const finalState = output.value;
		if (!finalState.answer) {
			throw new Error(finalState.error ?? 'ClassMate graph finished without an answer.');
		}
		const totalDurationMs = Date.now() - graphStartedAt;
		this._services.onDebug?.('graph_performance_summary', {
			totalDurationMs,
			nodeTimings: finalState.nodeTimings,
		});
		return {
			answer: finalState.answer,
			state: finalState,
			totalDurationMs,
			nodeTimings: finalState.nodeTimings,
		};
	}

	private async _measureNode(
		node: string,
		state: WrappedState,
		run: () => Promise<WrappedState>
	): Promise<WrappedState> {
		const startedAt = Date.now();
		const previousTimings = state.value.nodeTimings ?? [];
		const sequence = previousTimings.filter((item) => item.node === node).length + 1;
		this._services.onProgress?.(
			node,
			NODE_PROGRESS_MESSAGES[node] ?? '正在处理请求…'
		);
		try {
			const result = await run();
			const timing: GraphNodeTiming = {
				node,
				sequence,
				startedAt,
				durationMs: Date.now() - startedAt,
			};
			this._services.onDebug?.('graph_node_timing', timing);
			return nextState(result, {
				nodeTimings: [...(result.value.nodeTimings ?? previousTimings), timing],
			});
		} catch (error) {
			this._services.onDebug?.('graph_node_failed_timing', {
				node,
				sequence,
				startedAt,
				durationMs: Date.now() - startedAt,
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	}

	private _assertNotCancelled(): void {
		if (this._services.signal?.aborted) {
			throw new Error('ClassMate request was cancelled.');
		}
	}

	private async _prepare(state: WrappedState): Promise<WrappedState> {
		this._assertNotCancelled();
		const request = state.value.request;
		const initialRoute = preclassifyRequest(request.frontendIntent, request.userText, {
			source: request.requestSource,
			buttonId: request.buttonId,
		});
		const minimalWorkspaceContext = await this._services.workspaceProvider.getMinimalContext();
		return nextState(state, {
			initialRoute,
			minimalWorkspaceContext,
			requestType: initialRoute.requestType,
			actionType: getTaskDefinition(initialRoute.requestType).actionType,
			learnerState: buildLearnerState(request.userText, request.conversationHistory),
		});
	}

	/**
	 * 唯一的前置模型调用：一次完成分类、文件选择、Skill 选择和回答规划。
	 * 输入不包含活动文件预览、question.md 正文或 Skill 正文。
	 */
	private async _routeAndPlan(state: WrappedState): Promise<WrappedState> {
		this._assertNotCancelled();
		const current = state.value;
		const initialRoute = current.initialRoute!;
		const workspace = current.minimalWorkspaceContext!;
		const learnerState = current.learnerState!;
		const concepts = inferConcepts(current.request.userText);
		const fallback = fallbackPlan(initialRoute.requestType, concepts, learnerState);
		let skillGraph;
		try {
			skillGraph = await this._services.skillGraphLoader.load();
		} catch (error) {
			this._services.onDebug?.('route_and_plan_skill_catalog_degraded', String(error));
			skillGraph = {
				schemaVersion: 1 as const,
				graphVersion: 'unavailable',
				nodes: [],
			};
		}
		const messages = new RouteAndPlanPromptBuilder().build({
			skillCore: await this._services.skillContentLoader.loadText('SKILL.md'),
			skillCatalog: buildCompactSkillCatalog(skillGraph),
			initialRoute,
			learnerState,
			userText: current.request.userText,
			workspace,
		});

		let result: RouteAndPlanResult = {
			requestType: initialRoute.requestType,
			confidence: initialRoute.confidence,
			workspaceRequests: [],
			skillRequests: [],
			answerPlan: fallback.answerPlan,
			skillRetrievalQuery: fallback.skillRetrievalQuery,
			reason: `Local fallback: ${initialRoute.reason}`,
		};

		try {
			const completion = await this._services.model.complete(messages, {
				label: 'route_and_plan',
				temperature: 0,
				maxTokens: 500,
				jsonMode: true,
				// Planning is a small classification/selection task. DeepSeek V4
				// defaults to thinking mode, which can consume the whole output
				// budget before emitting JSON, so disable it for this node only.
				thinkingMode: 'disabled',
				signal: this._services.signal,
			});
			const parsed = routeAndPlanWireSchema.parse(parseJsonObject(completion.content));
			const requestType = enforceRouteLock(initialRoute, parsed.t);
			const skillRetrievalQuery = {
				requestType,
				concepts: parsed.q.length > 0
					? parsed.q.slice(0, 6)
					: fallback.skillRetrievalQuery.concepts,
				purposes: parsed.u.length > 0
					? parsed.u.slice(0, 4)
					: fallback.skillRetrievalQuery.purposes,
				learnerLevel: learnerState.level,
				hintLevel: learnerState.hintLevel,
				maxSections: 3,
				maxTokens: 1800,
			};
			const plannerResult = sanitizePlannerResult({
				answerPlan: {
					requestType,
					depthLevel: parsed.d,
					responsePattern: parsed.p.slice(0, 4),
					mustInclude: parsed.i.slice(0, 4),
					mustAvoid: parsed.a.slice(0, 4),
					allowCompleteCode: parsed.code,
					skillQuery: skillRetrievalQuery,
				},
				skillRetrievalQuery,
			}, requestType, learnerState);

			const allowedWorkspacePaths = new Set(
				workspace.catalog.files.map((file) => file.path)
			);
			const workspaceRequests: ContextRequest[] = parsed.f.slice(0, 3)
				.filter((target) => allowedWorkspacePaths.has(target))
				.map((target) => ({
					source: 'workspace',
					target,
					required: false,
					reason: 'RouteAndPlan selected this file.',
				}));
			const invalidWorkspaceRequests = parsed.f
				.filter((target) => !allowedWorkspacePaths.has(target));
			if (invalidWorkspaceRequests.length > 0) {
				this._services.onDebug?.(
					'route_and_plan_invalid_workspace_requests',
					invalidWorkspaceRequests
				);
			}

			const allowedSkillIds = new Set(skillGraph.nodes.map((node) => node.id));
			const skillRequests = parsed.s.slice(0, 3)
				.filter((id) => allowedSkillIds.has(id))
				.map((id) => ({
					id,
					required: false,
					reason: 'RouteAndPlan selected this Skill section.',
				}));
			const invalidSkillRequests = parsed.s
				.filter((id) => !allowedSkillIds.has(id));
			if (invalidSkillRequests.length > 0) {
				this._services.onDebug?.(
					'route_and_plan_invalid_skill_requests',
					invalidSkillRequests
				);
			}

			result = {
				requestType,
				confidence: initialRoute.confidence,
				workspaceRequests,
				skillRequests,
				answerPlan: plannerResult.answerPlan,
				skillRetrievalQuery: plannerResult.skillRetrievalQuery,
				reason: 'Single RouteAndPlan model decision.',
			};
		} catch (error) {
			this._services.onDebug?.('route_and_plan_fallback', String(error));
		}

		const explicitFileRequests = findExplicitWorkspaceRequests(
			current.request.userText,
			workspace.catalog.files
		);
		result = {
			...result,
			workspaceRequests: uniqueContextRequests([
				...result.workspaceRequests,
				...explicitFileRequests,
				...findDefaultWorkspaceRequests(result.requestType, current),
			]),
		};

		return nextState(state, {
			routeAndPlanResult: result,
			requestType: result.requestType,
			actionType: getTaskDefinition(result.requestType).actionType,
			answerPlan: result.answerPlan,
			skillRetrievalQuery: result.skillRetrievalQuery,
			skillRequests: result.skillRequests,
			routeAndPlanAttemptCount: current.routeAndPlanAttemptCount + 1,
		});
	}

	private async _loadContext(state: WrappedState): Promise<WrappedState> {
		this._assertNotCancelled();
		const current = state.value;
		const requests = current.routeAndPlanResult?.workspaceRequests ?? [];
		let loadedWorkspaceItems = current.loadedWorkspaceItems;
		try {
			loadedWorkspaceItems = await this._services.workspaceLoader.load(
				current.minimalWorkspaceContext!.catalog,
				requests
			);
		} catch (error) {
			this._services.onDebug?.('workspace_context_degraded', String(error));
		}
		return nextState(state, {
			loadedWorkspaceItems,
			processedContextRequestKeys: requests.map(contextRequestKey),
		});
	}

	private async _freezeRoute(state: WrappedState): Promise<WrappedState> {
		const current = state.value;
		const requestType = current.requestType
			?? current.initialRoute?.requestType
			?? 'unclassified';
		return nextState(state, {
			requestType,
			actionType: getTaskDefinition(requestType).actionType,
			requestTypeFrozen: true,
		});
	}

	private async _retrieveSkill(state: WrappedState): Promise<WrappedState> {
		const current = state.value;
		try {
			const graph = await this._services.skillGraphLoader.load();
			const requestedIds = new Set(current.skillRequests.map((request) => request.id));
			let skillCandidates: SkillCandidate[];
			if (requestedIds.size > 0) {
				skillCandidates = graph.nodes
					.filter((node) => requestedIds.has(node.id))
					.map((node) => ({
						node,
						score: 1,
						matchedBy: ['route-and-plan-selection'],
						relationsUsed: [],
					}));
			} else {
				skillCandidates = retrieveSkillCandidates(
					graph,
					current.skillRetrievalQuery!
				);
			}
			const extracted = await this._services.skillSectionExtractor.extractAll(skillCandidates);
			const assembled = assembleSkillContext(
				extracted,
				current.skillRetrievalQuery!.maxSections,
				current.skillRetrievalQuery!.maxTokens
			);
			return nextState(state, {
				skillCandidates,
				retrievedSkillSections: assembled.sections,
				assembledSkillContext: assembled.content,
				skillGraphVersion: graph.graphVersion,
				retrievalDegraded: skillCandidates.length > 0 && assembled.sections.length === 0,
			});
		} catch (error) {
			this._services.onDebug?.('skill_retrieval_degraded', String(error));
			return nextState(state, { retrievalDegraded: true, assembledSkillContext: '' });
		}
	}

	private async _freezeContext(state: WrappedState): Promise<WrappedState> {
		const current = state.value;
		return nextState(state, {
			workspaceSnapshot: buildWorkspaceSnapshot(
				current.minimalWorkspaceContext!,
				current.loadedWorkspaceItems
			),
			answerContextFrozen: true,
		});
	}

	/**
	 * 按用户要求，最终回答阶段仍完整提交精简后的 SKILL.md。
	 * 同时只提交规划阶段选中的 Skill 小节，不提交完整 Skill 目录。
	 */
	private async _buildAnswerPrompt(state: WrappedState): Promise<WrappedState> {
		const current = state.value;
		const messages = new AnswerPromptBuilder().build({
			skillCore: await this._services.skillContentLoader.loadText('SKILL.md'),
			pedagogy: await this._services.skillContentLoader.loadText('references/pedagogy.md'),
			answerPlan: current.answerPlan!,
			assembledSkillContext: current.assembledSkillContext ?? '',
			workspaceSnapshot: current.workspaceSnapshot!,
			userText: current.request.userText,
			conversationHistory: current.request.conversationHistory,
		});
		return nextState(state, { answerMessages: messages });
	}

	private async _answer(state: WrappedState): Promise<WrappedState> {
		this._assertNotCancelled();
		const current = state.value;
		const messages: LLMMessage[] = [...current.answerMessages];
		if (current.answerValidation && !current.answerValidation.valid) {
			messages.push({
				role: 'system',
				content: [
					'Regenerate the student-facing answer and fix every validation problem:',
					...current.answerValidation.problems.map((problem) => `- ${problem}`),
					'Do not mention this validation step.',
				].join('\n'),
			});
		}
		const completion = await this._services.model.complete(messages, {
			label: 'answer',
			temperature: 0.2,
			maxTokens: current.answerPlan?.requestType === 'problem_hint'
				&& current.answerPlan.depthLevel === 1
				? 700
				: 2200,
			thinkingMode: current.answerPlan?.requestType === 'problem_hint'
				&& current.answerPlan.depthLevel === 1
				? 'disabled'
				: undefined,
			signal: this._services.signal,
			onToken: this._services.onAnswerToken,
		});
		return nextState(state, {
			answer: completion.content.trim(),
			answerRetryCount: current.answerRetryCount + 1,
		});
	}

	private async _validate(state: WrappedState): Promise<WrappedState> {
		const current = state.value;
		let answer = current.answer ?? '';
		let answerValidation = validateStudentAnswer(answer, current.answerPlan!);
		if (
			!this._services.onAnswerToken
			&& !answerValidation.valid
			&& current.answerRetryCount > MAX_ANSWER_RETRIES
		) {
			const concepts = current.skillRetrievalQuery?.concepts.join('、') || '这个问题';
			answer = current.requestType === 'code_edit'
				? '这次生成的修改没有通过完整性检查，因此我没有把它作为可应用代码提交。请缩小修改范围后再试一次。'
				: `我先不给出可能超过当前提示层级的完整答案。请先围绕“${concepts}”写出你认为的下一步，我再根据你的尝试继续提示。`;
			answerValidation = validateStudentAnswer(answer, current.answerPlan!);
		}
		this._services.onDebug?.('answer_validation', answerValidation);
		return nextState(state, { answer, answerValidation });
	}
}
