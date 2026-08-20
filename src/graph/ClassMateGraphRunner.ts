import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import type { LLMMessage } from '../llm/types';
import { AnswerPromptBuilder } from '../prompts/answerPromptBuilder';
import { CorrectnessCheckPromptBuilder } from '../prompts/correctnessCheckPromptBuilder';
import { preclassifyRequest } from '../prompts/intentRouter';
import { ProblemConstraintPromptBuilder } from '../prompts/problemConstraintPromptBuilder';
import { ProblemIdentifierPromptBuilder } from '../prompts/problemIdentifierPromptBuilder';
import { RouteAndPlanPromptBuilder } from '../prompts/routeAndPlanPromptBuilder';
import type { ProblemCardExtractor } from '../problemKnowledge/problemCardExtractor';
import type { ProblemCardFactsLoader } from '../problemKnowledge/problemCardFactsLoader';
import type { ProblemCardIndexLoader } from '../problemKnowledge/problemCardIndexLoader';
import { retrieveProblemCardCandidates } from '../problemKnowledge/problemCandidateRetriever';
import { buildProblemRecognitionEvidence } from '../problemKnowledge/problemEvidenceBuilder';
import { assessProblemKnowledgeGate } from '../problemKnowledge/problemKnowledgeGate';
import { problemIdentificationWireSchema } from '../problemKnowledge/schemas';
import { assembleSkillContext } from '../skill/skillContextAssembler';
import { buildCompactSkillCatalog } from '../skill/skillCatalogBuilder';
import type { SkillContentLoader } from '../skill/skillContentLoader';
import type { SkillGraphLoader } from '../skill/skillGraphLoader';
import { retrieveSkillCandidates } from '../skill/skillGraphRetriever';
import type { SkillSectionExtractor } from '../skill/skillSectionExtractor';
import type { SkillCandidate } from '../skill/types';
import type { WorkspaceContextLoader } from '../workspace/workspaceContextLoader';
import {
	buildWorkspaceVersionIndex,
	diffWorkspaceVersions,
} from '../workspace/workspaceVersionIndex';
import { buildWorkspaceStructureMap } from '../workspace/workspaceStructureMap';
import { buildCppWorkspaceIndex } from '../parser/cppWorkspaceIndex';
import { detectCodeBlockSources } from '../chat/answerBlockSourceDetector';
import {
	buildGroundedLocalHint,
	buildGroundingRetryInstruction,
	checkAnswerGrounding,
} from '../chat/answerGroundingValidator';
import { buildRecoveryLocalHint } from '../chat/answerRecoveryHint';
import {
	buildReferenceTargetCatalog,
	finalizeAnswerReferences,
} from '../chat/answerReferenceFinalizer';
import type { WorkspaceContextProvider } from '../workspace/workspaceContextProvider';
import { planEvidenceBackfill } from '../workspace/evidenceBackfill';
import type {
	LoadedWorkspaceItem,
	MinimalWorkspaceContext,
	WorkspaceCatalog,
} from '../workspace/types';
import { buildWorkspaceSnapshot } from '../workspace/workspaceSnapshotBuilder';
import {
	assessAssignmentWorkspace,
	biasRequestTypeForWorkspace,
	deriveProblemRoot,
	inferContextMode,
	resolveContextMode,
	selectAssignmentFallbackRequests,
	selectFirstCallWorkspaceRequests,
	selectWorkspaceContextRequests,
} from '../workspace/contextPolicy';
import { getTaskDefinition } from './taskRegistry';
import {
	buildLearnerState,
	fallbackPlan,
	inferConcepts,
	sanitizePlannerResult,
	validateStudentAnswer,
} from './planning';
import {
	correctnessVerificationWireSchema,
	parseJsonObject,
	problemConstraintsWireSchema,
	routeAndPlanWireSchema,
} from './schemas';
import type {
	ClassMateGraphState,
	ClassMateRequest,
	ContextRequest,
	GraphNodeTrace,
	GraphNodeTiming,
	InitialRoute,
	ProblemConstraints,
	RequestType,
	RouteAndPlanResult,
} from './types';
import type { GraphModelClient } from './modelClient';

const MAX_ANSWER_RETRIES = 1;
const PURE_SOCIAL_PATTERN =
	/^(你好|您好|谢谢|感谢|再见|你是谁|hello|hi|thanks|thank you)[！!。.？?\s]*$/i;
const HIGH_RISK_REQUEST_TYPES = new Set<RequestType>([
	'compile_error_help',
	'runtime_error_help',
	'wrong_output_help',
	'oj_failure_help',
	'solution_request',
	'code_edit',
]);
const HIGH_RISK_QUESTION_PATTERN =
	/反例|举例|样例|复杂度|超时|\bTLE\b|\bWA\b|\bRE\b|写完整|完整代码|直接给.*代码|选哪个|哪项|算一下|计算|最短路|最小生成树|Dijkstra|Prim|Kruskal|Floyd|AVL|B\s*树|KMP/i;

export interface ClassMateGraphServices {
	workspaceProvider: WorkspaceContextProvider;
	workspaceLoader: WorkspaceContextLoader;
	skillContentLoader: SkillContentLoader;
	skillGraphLoader: SkillGraphLoader;
	skillSectionExtractor: SkillSectionExtractor;
	problemCardIndexLoader: ProblemCardIndexLoader;
	problemCardExtractor: ProblemCardExtractor;
	problemCardFactsLoader: ProblemCardFactsLoader;
	/**
	 * 当前工作区根目录的 URI 字符串(vscode.workspace.workspaceFolders[0])。
	 * 引用契约用它把符号的相对路径拼成可点击的真实文件 URI;
	 * 缺失时标记降级为行内代码,不生成链接。
	 */
	workspaceRootUri?: string;
	/**
	 * 扩展安装根目录(context.extensionPath)。Tree-sitter wasm 定位的
	 * 权威基准:VSIX 与 F5(dist) 布局下优先在此找 dist/wasm。
	 */
	extensionPath?: string;
	model: GraphModelClient;
	signal?: AbortSignal;
	onAnswerToken?: (token: string) => void;
	onProgress?: (node: string, message: string) => void;
	onDebug?: (event: string, data: unknown) => void;
	onNodeTrace?: (trace: GraphNodeTrace) => void;
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
	identify_problem: '正在识别当前题目…',
	load_problem_card: '正在读取相关题目提示…',
	retrieve_skill: '正在查找相关知识…',
	freeze_context: '正在整理回答所需内容…',
	load_evidence_backfill: '正在补读缺失的代码文件…',
	build_answer_prompt: '正在组织回答材料…',
	answer: '正在等待模型生成回答…',
	validate: '正在检查回答…',
	extract_constraints: '正在提取题目约束…',
	correctness_check: '正在核对答案正确性…',
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

function uniqueNonEmpty(values: string[], limit: number): string[] {
	return [...new Set(values.map((value) => value.trim()).filter(Boolean))].slice(0, limit);
}

function shouldRunCorrectnessCheck(state: ClassMateGraphState): boolean {
	const requestType = state.requestType ?? state.answerPlan?.requestType ?? 'unclassified';
	return HIGH_RISK_REQUEST_TYPES.has(requestType)
		|| HIGH_RISK_QUESTION_PATTERN.test(state.request.userText)
		|| Boolean(state.problemIdentification?.evidence.includes(
			'Exact indexed content hash matched.'
		));
}

function buildFallbackProblemConstraints(state: ClassMateGraphState): ProblemConstraints {
	const minimal = state.workspaceSnapshot?.minimal;
	return {
		hardConstraints: uniqueNonEmpty(state.answerPlan?.mustInclude ?? [], 12),
		requiredOperations: [],
		inputLimits: [],
		expectedBehaviors: uniqueNonEmpty([
			minimal?.expectedOutput
				? `Expected output: ${minimal.expectedOutput.slice(0, 300)}`
				: '',
			minimal?.actualOutput
				? `Actual output: ${minimal.actualOutput.slice(0, 300)}`
				: '',
		], 10),
		uncertainItems: state.loadedWorkspaceItems.length === 0
			? ['No workspace file body was loaded; do not invent assignment-specific facts.']
			: [],
		evidencePaths: state.loadedWorkspaceItems.map((item) => item.path).slice(0, 12),
	};
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

function isValidAssignmentRoot(
	root: string | null | undefined,
	files: Array<{ path: string }>
): root is string {
	if (!root || pathIsUnsafe(root)) {
		return false;
	}
	const normalizedRoot = root.replace(/\\/g, '/').replace(/^\.\/|\/+$/g, '');
	return files.some((file) => {
		const normalizedPath = file.path.replace(/\\/g, '/');
		return normalizedRoot === '.'
			|| normalizedPath === normalizedRoot
			|| normalizedPath.startsWith(`${normalizedRoot}/`);
	});
}

function pathIsUnsafe(value: string): boolean {
	const normalized = value.replace(/\\/g, '/');
	return normalized.startsWith('/')
		|| /^[a-z]:\//i.test(normalized)
		|| normalized.split('/').includes('..');
}

export class ClassMateGraphRunner {
	constructor(services: ClassMateGraphServices) {
		// 7.8 恢复通道:流式失败可能在异常抛出前已把半截内容交给界面。
		// 包装 onAnswerToken 记录"本轮是否已有任何 token 流出",供失败
		// 分支判断能否安全重试(重试会从头再流一遍,只能对零流出进行)。
		const onAnswerToken = services.onAnswerToken;
		this._services = onAnswerToken
			? {
				...services,
				onAnswerToken: (token: string) => {
					if (token.length > 0) {
						this._answerStreamedOut = true;
					}
					onAnswerToken(token);
				},
			}
			: services;
	}

	private readonly _services: ClassMateGraphServices;
	private _answerStreamedOut = false;

	private _emitNodeTrace(trace: GraphNodeTrace): void {
		try {
			this._services.onNodeTrace?.(trace);
		} catch (error) {
			console.warn('ClassMate graph node diagnostics trace failed:', error);
		}
	}

	public async run(request: ClassMateRequest): Promise<ClassMateGraphResult> {
		const graphStartedAt = Date.now();
		const initial: ClassMateGraphState = {
			request,
			requestTypeFrozen: false,
			answerContextFrozen: false,
			routeAndPlanAttemptCount: 0,
			processedContextRequestKeys: [],
			routeAndPlanWorkspacePreview: [],
			loadedWorkspaceItems: [],
			skillCandidates: [],
			retrievedSkillSections: [],
			skillRequests: [],
			retrievalDegraded: false,
			problemCardCandidates: [],
			problemKnowledgeDegraded: false,
			constraintExtractionDegraded: false,
			correctnessCheckRequired: false,
			answerMessages: [],
			answerRetryCount: 0,
			workspaceDriftRetryCount: 0,
			groundingRetryCount: 0,
			modelFailureCount: 0,
			evidenceBackfillCount: 0,
			workspaceDriftRegenerate: false,
			answerDelivered: false,
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
			.addNode('identify_problem', (state) =>
				this._measureNode('identify_problem', state, () => this._identifyProblem(state)))
			.addNode('load_problem_card', (state) =>
				this._measureNode('load_problem_card', state, () => this._loadProblemCard(state)))
			.addNode('retrieve_skill', (state) =>
				this._measureNode('retrieve_skill', state, () => this._retrieveSkill(state)))
			.addNode('freeze_context', (state) =>
				this._measureNode('freeze_context', state, () => this._freezeContext(state)))
			.addNode('load_evidence_backfill', (state) =>
				this._measureNode('load_evidence_backfill', state, () => this._loadEvidenceBackfill(state)))
			.addNode('extract_constraints', (state) =>
				this._measureNode('extract_constraints', state, () => this._extractConstraints(state)))
			.addNode('build_answer_prompt', (state) =>
				this._measureNode('build_answer_prompt', state, () => this._buildAnswerPrompt(state)))
			.addNode('answer', (state) =>
				this._measureNode('answer', state, () => this._answer(state)))
			.addNode('validate', (state) =>
				this._measureNode('validate', state, () => this._validate(state)))
			.addNode('verify_workspace', (state) =>
				this._measureNode('verify_workspace', state, () => this._verifyWorkspace(state)))
			.addNode('grounding_check', (state) =>
				this._measureNode('grounding_check', state, () => this._groundingCheck(state)))
			.addNode('correctness_check', (state) =>
				this._measureNode('correctness_check', state, () => this._correctnessCheck(state)))
			.addEdge(START, 'prepare')
			.addEdge('prepare', 'route_and_plan')
			.addEdge('route_and_plan', 'load_context')
			.addEdge('load_context', 'freeze_route')
			.addEdge('freeze_route', 'identify_problem')
			.addEdge('identify_problem', 'load_problem_card')
			.addEdge('load_problem_card', 'retrieve_skill')
			.addEdge('retrieve_skill', 'freeze_context')
			.addEdge('freeze_context', 'load_evidence_backfill')
			.addConditionalEdges('load_evidence_backfill', (state) =>
				// 7.8 缺证据补读:判定缺代码证据且配额未用尽时,补读后回
				// freeze_context 重建快照/符号索引,再走约束提取与回答构建。
				state.value.evidenceBackfillPending ? 'freeze_context' : 'extract_constraints'
			)
			.addEdge('extract_constraints', 'build_answer_prompt')
			.addEdge('build_answer_prompt', 'answer')
			.addEdge('answer', 'validate')
			.addConditionalEdges('validate', (state) => {
				// 7.8 恢复通道:answer 模型调用失败(非取消)且未重试过,
				// 回到 answer 用同一提示重试一次。recoveryAttempt 是 answer
				// 失败分支设置的瞬时标记,重试成功或转兜底时清除。
				if (state.value.recoveryAttempt && state.value.modelFailureCount <= 1) {
					return 'answer';
				}
				return state.value.answerValidation?.shouldRegenerate
					// 已经显示到界面的回答不能静默替换；仍在缓冲区的高风险回答可以重试。
					&& !state.value.answerDelivered
					&& state.value.answerRetryCount <= MAX_ANSWER_RETRIES
					? 'answer'
					: 'verify_workspace';
			})
			.addConditionalEdges('verify_workspace', (state) =>
				// 复核发现漂移且回答未流出:已重建快照,按新工作区重生成一次。
				// workspaceDriftRegenerate 是本步刚重载的瞬时标记,
				// 由 build_answer_prompt 消耗,避免第二次经过时再次路由回去。
				state.value.workspaceDriftRegenerate
					&& !state.value.answerDelivered
					&& !state.value.answerValidation?.shouldRegenerate
					? 'build_answer_prompt'
					: 'grounding_check'
			)
			.addConditionalEdges('grounding_check', (state) =>
				// 结构事实冲突且回答未流出:grounding_check 设置一次性
				// groundingCorrectionInstruction,answer 消费后清除并回到
				// validate→verify_workspace→grounding_check 复核。
				state.value.groundingCorrectionInstruction
					? 'answer'
					: 'correctness_check'
			)
			.addConditionalEdges('correctness_check', (state) =>
				state.value.answerValidation?.shouldRegenerate
					&& !state.value.answerDelivered
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
			const completed = nextState(result, {
				nodeTimings: [...(result.value.nodeTimings ?? previousTimings), timing],
			});
			this._emitNodeTrace({
				...timing,
				status: 'completed',
				inputState: state.value,
				state: completed.value,
			});
			return completed;
		} catch (error) {
			const normalizedError = error instanceof Error
				? { name: error.name, message: error.message, stack: error.stack }
				: { name: 'Error', message: String(error) };
			const timing: GraphNodeTiming = {
				node,
				sequence,
				startedAt,
				durationMs: Date.now() - startedAt,
			};
			this._services.onDebug?.('graph_node_failed_timing', {
				...timing,
				error: normalizedError.message,
			});
			this._emitNodeTrace({
				...timing,
				status: 'failed',
				inputState: state.value,
				state: state.value,
				error: normalizedError,
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
		const minimalWorkspaceContext = await this._services.workspaceProvider.getMinimalContext();
		const localRoute = preclassifyRequest(request.frontendIntent, request.userText, {
			source: request.requestSource,
			buttonId: request.buttonId,
		});
		const biasedRequestType = biasRequestTypeForWorkspace(
			localRoute.requestType,
			request.userText,
			minimalWorkspaceContext,
			request.previousWorkspaceContext
		);
		const initialRoute: InitialRoute = {
			...localRoute,
			requestType: biasedRequestType,
			reason: biasedRequestType === localRoute.requestType
				? localRoute.reason
				: `${localRoute.reason} Assignment workspace bias selected ${biasedRequestType}.`,
		};
		return nextState(state, {
			initialRoute,
			minimalWorkspaceContext,
			requestType: initialRoute.requestType,
			contextMode: inferContextMode(
				initialRoute.requestType,
				minimalWorkspaceContext,
				request.userText,
				request.previousWorkspaceContext
			),
			actionType: getTaskDefinition(initialRoute.requestType).actionType,
			learnerState: buildLearnerState(request.userText, request.conversationHistory),
		});
	}

	/**
	 * 唯一的前置模型调用：一次完成分类、文件选择、Skill 选择和回答规划。
	 * 小型作业目录会按控制器预算附带文件正文；大型工作区仍只附带目录
	 * 以及题目文件、活动文件等少量确定性上下文。
	 */
	private async _routeAndPlan(state: WrappedState): Promise<WrappedState> {
		this._assertNotCancelled();
		const current = state.value;
		const initialRoute = current.initialRoute!;
		const workspace = current.minimalWorkspaceContext!;
		const learnerState = current.learnerState!;
		const concepts = inferConcepts(current.request.userText);
		const fallback = fallbackPlan(initialRoute.requestType, concepts, learnerState);
		const localAssignment = assessAssignmentWorkspace(
			workspace,
			current.request.previousWorkspaceContext
		);
		const firstCallRequests = selectFirstCallWorkspaceRequests(
			workspace,
			current.request.previousWorkspaceContext
		);
		let workspacePreview: LoadedWorkspaceItem[] = [];
		if (firstCallRequests.length > 0) {
			try {
				workspacePreview = await this._services.workspaceLoader.load(
					workspace.catalog,
					firstCallRequests
				);
			} catch (error) {
				this._services.onDebug?.(
					'route_and_plan_workspace_preview_degraded',
					String(error)
				);
			}
		}
		// 部分加载的大工作区:正文没进 preview 的代码文件以符号结构图形式
		// 提交给 Route,让模型能按符号点名文件而不是按文件名猜。
		let workspaceStructureMap: Awaited<ReturnType<typeof buildWorkspaceStructureMap>> | undefined;
		const previewPaths = new Set(workspacePreview.map((item) =>
			item.path.replace(/\\/g, '/').toLocaleLowerCase()));
		const unloadedCode = workspace.catalog.files.filter((entry) =>
			entry.kind === 'code'
			&& !previewPaths.has(entry.path.replace(/\\/g, '/').toLocaleLowerCase()));
		if (unloadedCode.length > 0 && unloadedCode.length <= 80) {
			try {
				const structureFiles = await Promise.all(unloadedCode.map(async (entry) => ({
					path: entry.path,
					kind: entry.kind,
					content: (await this._services.workspaceLoader.load(workspace.catalog, [{
						source: 'workspace',
						target: entry.path,
						required: false,
						reason: 'Structure map parsing.',
					}]))[0]?.content ?? '',
				})));
				workspaceStructureMap = await buildWorkspaceStructureMap(
					structureFiles.filter((file) => file.content.length > 0),
					{ extensionPath: this._services.extensionPath }
				);
			} catch (error) {
				this._services.onDebug?.(
					'route_and_plan_structure_map_degraded',
					String(error)
				);
			}
		}
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
			workspacePreview,
			workspaceStructureMap,
		});

		let result: RouteAndPlanResult = {
			requestType: initialRoute.requestType,
			contextMode: inferContextMode(
				initialRoute.requestType,
				workspace,
				current.request.userText,
				current.request.previousWorkspaceContext
			),
			confidence: initialRoute.confidence,
			isAssignmentWorkspace: localAssignment.isAssignmentWorkspace,
			assignmentRoot: localAssignment.assignmentRoot,
			assignmentEvidence: localAssignment.evidence,
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
			const lockedRequestType = enforceRouteLock(initialRoute, parsed.t);
			const requestType = biasRequestTypeForWorkspace(
				lockedRequestType,
				current.request.userText,
				workspace,
				current.request.previousWorkspaceContext
			);
			let contextMode = resolveContextMode(
				requestType,
				parsed.m,
				workspace,
				current.request.userText,
				current.request.previousWorkspaceContext
			);
			const isAssignmentWorkspace =
				localAssignment.isAssignmentWorkspace || parsed.w;
			if (
				isAssignmentWorkspace
				&& contextMode === 'none'
				&& !PURE_SOCIAL_PATTERN.test(current.request.userText.trim())
			) {
				contextMode = workspace.questionFile
					? 'problem_context'
					: 'active_file';
			}
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
			const workspaceRequests: ContextRequest[] = parsed.f
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
				contextMode,
				confidence: initialRoute.confidence,
				isAssignmentWorkspace,
				assignmentRoot: localAssignment.assignmentRoot
					?? (isAssignmentWorkspace
						&& isValidAssignmentRoot(parsed.r, workspace.catalog.files)
						? parsed.r
						: undefined),
				assignmentEvidence: [
					...localAssignment.evidence,
					...parsed.e,
				].slice(0, 6),
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
			workspaceRequests: selectWorkspaceContextRequests({
				requestType: result.requestType,
				contextMode: result.contextMode,
				workspace,
				userText: current.request.userText,
				modelRequests: [
					...firstCallRequests,
					...result.workspaceRequests,
				],
				explicitRequests: explicitFileRequests,
				previous: current.request.previousWorkspaceContext,
			}),
		};

		return nextState(state, {
			routeAndPlanResult: result,
			routeAndPlanWorkspacePreview: workspacePreview,
			requestType: result.requestType,
			contextMode: result.contextMode,
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
		const previewByPath = new Map(
			current.routeAndPlanWorkspacePreview.map((item) => [
				item.path.replace(/\\/g, '/').toLocaleLowerCase(),
				item,
			])
		);
		const workspaceRequests = requests.filter(
			(request) => request.source === 'workspace'
		);
		const canReusePreview = workspaceRequests.length > 0
			&& workspaceRequests.every((request) =>
				!request.section
				&& previewByPath.has(
					request.target.replace(/\\/g, '/').toLocaleLowerCase()
				));
		if (canReusePreview) {
			// Route 调用期间学生可能继续编辑(尤其未保存缓冲区)。缓冲区加载的
			// preview 带 bufferVersion,复用前对比当前文档 version,version 变化
			// 就放弃复用改为重新加载;磁盘加载的 preview 保持原复用行为(磁盘
			// 变更由 catalog 的 modifiedAt/size 指纹反映)。
			const staleTargets = workspaceRequests
				.map((request) => previewByPath.get(
					request.target.replace(/\\/g, '/').toLocaleLowerCase()
				))
				.filter((item): item is NonNullable<typeof item> => item !== undefined)
				.filter((item) => !this._services.workspaceLoader.isItemFresh(
					current.minimalWorkspaceContext!.catalog,
					item
				));
			if (staleTargets.length === 0) {
				loadedWorkspaceItems = [...new Set(
					workspaceRequests.map((request) =>
						previewByPath.get(
							request.target.replace(/\\/g, '/').toLocaleLowerCase()
						)!)
				)];
				this._services.onDebug?.(
					'workspace_context_reused_route_and_plan_preview',
					loadedWorkspaceItems.map((item) => item.path)
				);
			} else {
				try {
					loadedWorkspaceItems = await this._services.workspaceLoader.load(
						current.minimalWorkspaceContext!.catalog,
						requests
					);
					this._services.onDebug?.(
						'workspace_context_preview_stale_reloaded',
						loadedWorkspaceItems.map((item) => item.path)
					);
				} catch (error) {
					this._services.onDebug?.('workspace_context_degraded', String(error));
				}
			}
		} else {
			try {
				loadedWorkspaceItems = await this._services.workspaceLoader.load(
					current.minimalWorkspaceContext!.catalog,
					requests
				);
			} catch (error) {
				this._services.onDebug?.('workspace_context_degraded', String(error));
			}
		}
		if (
			loadedWorkspaceItems.length === 0
			&& current.routeAndPlanResult?.isAssignmentWorkspace
		) {
			const fallbackRequests = selectAssignmentFallbackRequests(
				current.minimalWorkspaceContext!,
				current.request.previousWorkspaceContext
			);
			try {
				loadedWorkspaceItems = await this._services.workspaceLoader.load(
					current.minimalWorkspaceContext!.catalog,
					fallbackRequests
				);
				this._services.onDebug?.('workspace_context_assignment_fallback', {
					requested: fallbackRequests.map((request) => request.target),
					loaded: loadedWorkspaceItems.map((item) => item.path),
				});
			} catch (error) {
				this._services.onDebug?.(
					'workspace_context_assignment_fallback_degraded',
					String(error)
				);
			}
		}
		return nextState(state, {
			loadedWorkspaceItems,
			processedContextRequestKeys: requests.map(contextRequestKey),
			conversationWorkspaceContext: {
				problemRoot: current.routeAndPlanResult?.assignmentRoot
					?? deriveProblemRoot(
						current.minimalWorkspaceContext!,
						current.request.previousWorkspaceContext
					),
				questionPath: current.minimalWorkspaceContext?.questionFile
					?? current.request.previousWorkspaceContext?.questionPath,
				activeSourcePath: current.minimalWorkspaceContext?.catalog.activeEditor?.fileName
					?? current.request.previousWorkspaceContext?.activeSourcePath,
				relatedPaths: loadedWorkspaceItems.map((item) => item.path),
			fileHashes: Object.fromEntries(
				loadedWorkspaceItems.map((item) => [item.path, item.contentHash])
			),
				previousRequestType: current.requestType,
				previousContextMode: current.contextMode,
				isAssignmentWorkspace:
					current.routeAndPlanResult?.isAssignmentWorkspace
					?? current.request.previousWorkspaceContext?.isAssignmentWorkspace,
			},
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

	/**
	 * 只在工作区或问题带有具体数据结构作业信号时调用一次轻量识别模型。
	 * 识别阶段只能从本地预筛的候选 ID 中选择，不接收知识卡正文。
	 */
	private async _identifyProblem(state: WrappedState): Promise<WrappedState> {
		this._assertNotCancelled();
		const current = state.value;
		const evidence = buildProblemRecognitionEvidence({
			userText: current.request.userText,
			workspace: current.minimalWorkspaceContext!,
			loadedItems: current.loadedWorkspaceItems,
		});
		let index;
		try {
			index = await this._services.problemCardIndexLoader.load();
		} catch (error) {
			this._services.onDebug?.('problem_card_index_degraded', String(error));
			return nextState(state, {
				problemRecognitionEvidence: evidence,
				problemKnowledgeDegraded: true,
			});
		}
		const gate = assessProblemKnowledgeGate(evidence, index.cards);
		this._services.onDebug?.('problem_knowledge_gate', gate);

		const previous = current.request.previousWorkspaceContext;
		const explicitProblemSwitchPattern =
			/(换一题|换个题|另一题|新题|换个问题|另外一个作业|切换(?:到)?(?:题目|作业))/i;
		const hasStableWorkspaceIdentity = Boolean(
			evidence.activeFile
			|| evidence.questionFile
			|| current.loadedWorkspaceItems.length > 0
		);
		const mayReusePrevious = Boolean(
			previous?.problemCardId
			&& previous.problemFingerprint === evidence.fingerprint
			&& !explicitProblemSwitchPattern.test(current.request.userText)
		);

		if (!gate.shouldIdentify && !mayReusePrevious) {
			return nextState(state, {
				problemRecognitionEvidence: evidence,
				problemIdentification: {
					confidence: 0,
					evidence: gate.reasons,
					reason: 'Local gate did not find a concrete data-structure assignment signal.',
					reused: false,
				},
			});
		}

		const normalizedUserText = current.request.userText
			.toLocaleLowerCase()
			.replace(/[_.\s/\\()[\]（）【】\-]+/g, '');
		const mentionsDifferentCard = !hasStableWorkspaceIdentity
			&& index.cards.some((card) => {
				if (card.id === previous?.problemCardId) {
					return false;
				}
				return [card.number, ...card.ojIds, card.title, ...card.aliases]
					.map((value) => value
						.toLocaleLowerCase()
						.replace(/[_.\s/\\()[\]（）【】\-]+/g, ''))
					.some((value) => value.length >= 3 && normalizedUserText.includes(value));
			});
		const canReusePrevious = mayReusePrevious && !mentionsDifferentCard;
		if (canReusePrevious) {
			const previousCard = index.cards.find((card) => card.id === previous!.problemCardId);
			const previousVariant = previousCard?.variants.find(
				(variant) => variant.id === previous!.problemCardVariantId
			);
			if (previousCard && (!previous!.problemCardVariantId || previousVariant)) {
				const decision = {
					cardId: previousCard.id,
					variantId: previousVariant?.id,
					confidence: previous!.problemCardConfidence ?? 0.82,
					evidence: ['Reused the same assignment card from the previous turn.'],
					reason: 'Stable problem fingerprint and continuing conversation.',
					reused: true,
				};
				this._services.onDebug?.('problem_identification_reused', decision);
				return nextState(state, {
					problemRecognitionEvidence: evidence,
					problemIdentification: decision,
					conversationWorkspaceContext: {
						...current.conversationWorkspaceContext!,
						problemCardId: decision.cardId,
						problemCardVariantId: decision.variantId,
						problemCardConfidence: decision.confidence,
						problemFingerprint: evidence.fingerprint,
					},
				});
			}
		}

		const candidates = retrieveProblemCardCandidates(index, evidence);
		if (candidates.length === 0) {
			this._services.onDebug?.('problem_identification_no_candidates', gate.reasons);
			return nextState(state, {
				problemRecognitionEvidence: evidence,
				problemCardCandidates: [],
				problemIdentification: {
					confidence: 0,
					evidence: gate.reasons,
					reason: 'No indexed problem card matched the local evidence.',
					reused: false,
				},
			});
		}

		const localExactHashSelection = candidates.find((candidate) =>
			candidate.matchedBy.some((item) => item.startsWith('contentHash:'))
			|| candidate.variantScores.some((variant) =>
				variant.matchedBy.some((item) => item.startsWith('contentHash:')))
		);
		const localExactHashVariant = localExactHashSelection?.variantScores.find(
			(variant) => variant.matchedBy.some((item) => item.startsWith('contentHash:'))
		)?.variant;
		const acceptLocalExactHash = (reason: string): WrappedState => {
			const decision = {
				cardId: localExactHashSelection!.card.id,
				variantId: localExactHashVariant?.id,
				confidence: 0.99,
				evidence: ['Exact indexed content hash matched.'],
				reason,
				reused: false,
			};
			this._services.onDebug?.('problem_identification_exact_hash', decision);
			return nextState(state, {
				problemRecognitionEvidence: evidence,
				problemCardCandidates: candidates,
				problemIdentification: decision,
				conversationWorkspaceContext: {
					...current.conversationWorkspaceContext!,
					problemCardId: decision.cardId,
					problemCardVariantId: decision.variantId,
					problemCardConfidence: decision.confidence,
					problemFingerprint: evidence.fingerprint,
				},
			});
		};

		try {
			const messages = new ProblemIdentifierPromptBuilder().build({
				evidence,
				candidates,
			});
			const completion = await this._services.model.complete(messages, {
				label: 'identify_problem',
				temperature: 0,
				maxTokens: 260,
				jsonMode: true,
				thinkingMode: 'disabled',
				signal: this._services.signal,
			});
			const parsed = problemIdentificationWireSchema.parse(
				parseJsonObject(completion.content)
			);
			const selected = localExactHashSelection
				?? (parsed.id
					? candidates.find((candidate) => candidate.card.id === parsed.id)
					: undefined);
			if (!selected) {
				const decision = {
					confidence: parsed.c,
					evidence: parsed.e,
					reason: parsed.id
						? 'The identifier returned an id outside the validated candidate set.'
						: parsed.r,
					reused: false,
				};
				this._services.onDebug?.('problem_identification_rejected', decision);
				return nextState(state, {
					problemRecognitionEvidence: evidence,
					problemCardCandidates: candidates,
					problemIdentification: decision,
				});
			}

			const evidenceKinds = new Set(
				selected.matchedBy.map((item) => item.split(':', 1)[0])
			);
			const hasExactContentHash = Boolean(localExactHashSelection);
			if (hasExactContentHash) {
				evidenceKinds.add('contentHash');
			}
			const effectiveConfidence = hasExactContentHash
				? Math.max(parsed.c, 0.99)
				: parsed.c;
			const highConfidence =
				hasExactContentHash
				|| (effectiveConfidence >= 0.82 && selected.score >= 0.20);
			const supportedMediumConfidence =
				effectiveConfidence >= 0.65
				&& selected.score >= 0.28
				&& evidenceKinds.size >= 2;
			const runnerUp = candidates.find((candidate) => candidate.card.id !== selected.card.id);
			const ambiguous =
				Boolean(runnerUp)
				&& selected.score - runnerUp!.score < 0.06
				&& !hasExactContentHash
				&& !selected.matchedBy.some((item) =>
					item.startsWith('identity:')
					|| item.startsWith('contentHash:')
				);
			if ((!highConfidence && !supportedMediumConfidence) || ambiguous) {
				const decision = {
					confidence: effectiveConfidence,
					evidence: parsed.e,
					reason: ambiguous
						? 'Top problem candidates were too close to distinguish safely.'
						: 'The match did not meet the local evidence and confidence threshold.',
					reused: false,
				};
				this._services.onDebug?.('problem_identification_rejected', decision);
				return nextState(state, {
					problemRecognitionEvidence: evidence,
					problemCardCandidates: candidates,
					problemIdentification: decision,
				});
			}

			const requestedVariant = parsed.v
				? selected.card.variants.find((variant) => variant.id === parsed.v)
				: undefined;
			const variant = requestedVariant ?? localExactHashVariant;
			const decision = {
				cardId: selected.card.id,
				variantId: variant?.id,
				confidence: effectiveConfidence,
				evidence: hasExactContentHash
					? [...parsed.e, 'Exact indexed content hash matched.'].slice(0, 4)
					: parsed.e,
				reason: hasExactContentHash
					? 'Exact indexed file content matched after the identifier call.'
					: parsed.r,
				reused: false,
			};
			this._services.onDebug?.('problem_identification_accepted', {
				...decision,
				localScore: selected.score,
				localEvidence: selected.matchedBy,
			});
			return nextState(state, {
				problemRecognitionEvidence: evidence,
				problemCardCandidates: candidates,
				problemIdentification: decision,
				conversationWorkspaceContext: {
					...current.conversationWorkspaceContext!,
					problemCardId: decision.cardId,
					problemCardVariantId: decision.variantId,
					problemCardConfidence: decision.confidence,
					problemFingerprint: evidence.fingerprint,
				},
			});
		} catch (error) {
			this._services.onDebug?.('problem_identification_degraded', String(error));
			if (localExactHashSelection) {
				return acceptLocalExactHash(
					'Exact indexed file content matched after the identifier call degraded.'
				);
			}
			return nextState(state, {
				problemRecognitionEvidence: evidence,
				problemCardCandidates: candidates,
				problemKnowledgeDegraded: true,
			});
		}
	}

	private async _loadProblemCard(state: WrappedState): Promise<WrappedState> {
		const current = state.value;
		const decision = current.problemIdentification;
		if (!decision?.cardId) {
			return state;
		}
		try {
			const index = await this._services.problemCardIndexLoader.load();
			const card = index.cards.find((candidate) => candidate.id === decision.cardId);
			if (!card) {
				throw new Error(`Problem card id no longer exists: ${decision.cardId}`);
			}
			const variant = decision.variantId
				? card.variants.find((candidate) => candidate.id === decision.variantId)
				: undefined;
			if (decision.variantId && !variant) {
				throw new Error(`Problem card variant no longer exists: ${decision.variantId}`);
			}
			const loadedProblemCard = await this._services.problemCardExtractor.extract(
				card,
				variant
			);
			const loadedProblemCardFacts =
				await this._services.problemCardFactsLoader.select(
					index,
					card.id,
					variant?.id
				);
			const exactSnapshotMatched = decision.evidence.includes(
				'Exact indexed content hash matched.'
			);
			const selectedFacts =
				loadedProblemCardFacts.variant ?? loadedProblemCardFacts.card;
			const exactDiagnostic = exactSnapshotMatched
				? `主要结论必须围绕：${selectedFacts.primaryConclusion}`
				: undefined;
			const forbidInventedTest = exactSnapshotMatched
				&& selectedFacts.kind === 'diagnostic'
				&& selectedFacts.verifiedTests.length === 0
				? '该故障卡没有经过核验的具体样例，不得编造输入、操作数或期望输出；只能说明测试数据需要满足的条件。'
				: undefined;
			return nextState(state, {
				loadedProblemCard,
				loadedProblemCardFacts,
				assembledProblemCardContext: loadedProblemCard.content,
				answerPlan: exactDiagnostic
					? {
						...current.answerPlan!,
						mustInclude: [
							exactDiagnostic,
							...selectedFacts.answerRequirements.slice(0, 2),
							...current.answerPlan!.mustInclude,
						].slice(0, 4),
						mustAvoid: [
							...(forbidInventedTest ? [forbidInventedTest] : []),
							...current.answerPlan!.mustAvoid,
						].slice(0, 4),
					}
					: current.answerPlan,
			});
		} catch (error) {
			this._services.onDebug?.('problem_card_load_degraded', String(error));
			return nextState(state, {
				problemKnowledgeDegraded: true,
				loadedProblemCardFacts: undefined,
				assembledProblemCardContext: '',
			});
		}
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
		// 引用契约:对已加载的代码文件建一次符号索引,作为候选引用目标。
		let workspaceSymbols: ClassMateGraphState['workspaceSymbols'];
		try {
			workspaceSymbols = await buildCppWorkspaceIndex(
				current.loadedWorkspaceItems
					.filter((item) => item.kind === 'code')
					.map((item) => ({ path: item.path, content: item.content })),
				{ extensionPath: this._services.extensionPath }
			);
		} catch (error) {
			this._services.onDebug?.('workspace_symbol_index_degraded', String(error));
		}
		return nextState(state, {
			workspaceSnapshot: buildWorkspaceSnapshot(
				current.minimalWorkspaceContext!,
				current.loadedWorkspaceItems
			),
			workspaceVersionIndex: buildWorkspaceVersionIndex(
				current.minimalWorkspaceContext!.catalog,
				current.loadedWorkspaceItems
			),
			workspaceSymbols,
			answerContextFrozen: true,
			// 消费补读回环标记:快照已按补读后的条目重建,
			// 再次经过 load_evidence_backfill 不会再因旧标记回环。
			evidenceBackfillPending: undefined,
		});
	}

	/**
	 * 7.8 缺证据补读(程序侧确定性判定,最多两轮):
	 * 用户点名了未加载的代码文件,或代码类问题一个代码文件都没加载时,
	 * 从 catalog 生成补读请求加载目标,回 freeze_context 重建快照与
	 * 符号索引。找不到可补目标/配额用尽/加载失败时静默继续原链路。
	 */
	private async _loadEvidenceBackfill(state: WrappedState): Promise<WrappedState> {
		const current = state.value;
		const processedTargets = new Set(
			current.processedContextRequestKeys
				.filter((key) => key.startsWith('workspace|'))
				.map((key) => key.slice('workspace|'.length).split('|')[0])
		);
		const plan = planEvidenceBackfill({
			userText: current.request.userText,
			requestType: current.requestType ?? current.answerPlan?.requestType,
			minimal: current.minimalWorkspaceContext!,
			loadedItems: current.loadedWorkspaceItems,
			processedTargets,
			backfillCount: current.evidenceBackfillCount,
		});
		if (!plan) {
			return nextState(state, { evidenceBackfillPending: undefined });
		}
		try {
			this._assertNotCancelled();
			const loaded = await this._services.workspaceLoader.load(
				current.minimalWorkspaceContext!.catalog,
				plan.requests
			);
			const byPath = new Map(current.loadedWorkspaceItems.map((item) => [
				item.path.replace(/\\/g, '/').toLocaleLowerCase(),
				item,
			] as const));
			for (const item of loaded) {
				byPath.set(item.path.replace(/\\/g, '/').toLocaleLowerCase(), item);
			}
			this._services.onDebug?.('evidence_backfill', {
				round: current.evidenceBackfillCount + 1,
				reason: plan.reason,
				targets: plan.requests.map((request) => request.target),
				loaded: loaded.map((item) => item.path),
			});
			return nextState(state, {
				loadedWorkspaceItems: [...byPath.values()],
				processedContextRequestKeys: [
					...new Set([
						...current.processedContextRequestKeys,
						...plan.requests.map(contextRequestKey),
					]),
				],
				evidenceBackfillCount: current.evidenceBackfillCount + 1,
				// 瞬时标记:freeze_context 重建完快照后清除。
				evidenceBackfillPending: plan.requests,
			});
		} catch (error) {
			this._services.onDebug?.('evidence_backfill_degraded', String(error));
			return nextState(state, { evidenceBackfillPending: undefined });
		}
	}

	/**
	 * 高风险问题在生成答案前先提取短约束表。
	 * 失败时退化到本地可确定的信息，不阻断正常答疑。
	 */
	private async _extractConstraints(state: WrappedState): Promise<WrappedState> {
		const current = state.value;
		const correctnessCheckRequired = shouldRunCorrectnessCheck(current);
		const fallback = buildFallbackProblemConstraints(current);
		if (!correctnessCheckRequired) {
			return nextState(state, {
				correctnessCheckRequired,
				problemConstraints: fallback,
			});
		}
		try {
			this._assertNotCancelled();
			const messages = new ProblemConstraintPromptBuilder().build({
				userText: current.request.userText,
				answerPlan: current.answerPlan!,
				workspaceSnapshot: current.workspaceSnapshot!,
				problemCardFacts: current.loadedProblemCardFacts,
			});
			const completion = await this._services.model.complete(messages, {
				label: 'extract_constraints',
				temperature: 0,
				maxTokens: 700,
				jsonMode: true,
				thinkingMode: 'disabled',
				signal: this._services.signal,
			});
			const parsed = problemConstraintsWireSchema.parse(
				parseJsonObject(completion.content)
			);
			const allowedPaths = new Set(current.loadedWorkspaceItems.map((item) => item.path));
			const problemConstraints: ProblemConstraints = {
				hardConstraints: uniqueNonEmpty([...parsed.h, ...fallback.hardConstraints], 12),
				requiredOperations: uniqueNonEmpty(parsed.o, 10),
				inputLimits: uniqueNonEmpty(parsed.l, 10),
				expectedBehaviors: uniqueNonEmpty([...parsed.e, ...fallback.expectedBehaviors], 10),
				uncertainItems: uniqueNonEmpty(parsed.u, 8),
				evidencePaths: uniqueNonEmpty(
					[
						...parsed.p.filter((path) => allowedPaths.has(path)),
						...fallback.evidencePaths,
					],
					12
				),
			};
			problemConstraints.uncertainItems = uniqueNonEmpty([
				...problemConstraints.uncertainItems,
				...fallback.uncertainItems,
			], 8);
			this._services.onDebug?.('problem_constraints_extracted', problemConstraints);
			return nextState(state, {
				correctnessCheckRequired,
				problemConstraints,
			});
		} catch (error) {
			this._services.onDebug?.('problem_constraint_extraction_degraded', String(error));
			return nextState(state, {
				correctnessCheckRequired,
				problemConstraints: fallback,
				constraintExtractionDegraded: true,
			});
		}
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
			problemConstraints: current.problemConstraints,
			assembledSkillContext: current.assembledSkillContext ?? '',
			assembledProblemCardContext: current.assembledProblemCardContext,
			problemCardFacts: current.loadedProblemCardFacts,
			problemCardMatch: current.problemIdentification?.cardId
				? {
					cardId: current.problemIdentification.cardId,
					variantId: current.problemIdentification.variantId,
					confidence: current.problemIdentification.confidence,
					evidence: current.problemIdentification.evidence,
				}
				: undefined,
			workspaceSnapshot: current.workspaceSnapshot!,
			previousFileHashes: current.request.previousWorkspaceContext?.fileHashes,
			referenceTargets: current.workspaceSymbols
				? buildReferenceTargetCatalog(current.workspaceSymbols.symbols).targets
				: undefined,
			userText: current.request.userText,
			conversationHistory: current.request.conversationHistory,
		});
		// 消费漂移重生成标记:本轮回答基于重载后的快照,标记复位后
		// 再次经过 verify_workspace 不会重复路由回来。
		return nextState(state, {
			answerMessages: messages,
			workspaceDriftRegenerate: false,
		});
	}

	private async _answer(state: WrappedState): Promise<WrappedState> {
		this._assertNotCancelled();
		const current = state.value;
		// 引用契约:候选目标存在时,带引用的回答必须完整缓冲,
		// 标记在交付前由程序确定性转换(第一版;流式过滤在 perf 阶段)。
		const hasReferenceTargets = (current.workspaceSymbols?.symbols.length ?? 0) > 0;
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
		// 7.7 事实冲突重生成:本地事实作为硬约束注入(一次性,由
		// grounding_check 设置,answer 消费后随新状态自然清除)。
		if (current.groundingCorrectionInstruction) {
			messages.push({
				role: 'system',
				content: current.groundingCorrectionInstruction,
			});
		}
		// 事实冲突重生成期间继续缓冲(与首轮同等处理),避免半成品流出。
		const groundingRetrying = Boolean(current.groundingCorrectionInstruction);
		// 高风险回答先缓冲，等正确性检查通过后再交给界面；普通问题继续直接流式输出。
		// 引用契约生效时(候选目标非空)同样缓冲:标记必须先经程序转换,
		// 不能把 {{ref:...}} 直接流给学生。
		const streamImmediately = !current.correctnessCheckRequired
			&& !hasReferenceTargets
			&& current.answerRetryCount === 0
			&& !groundingRetrying;
		let completion: Awaited<ReturnType<ClassMateGraphServices['model']['complete']>>;
		try {
			completion = await this._services.model.complete(messages, {
				label: 'answer',
				temperature: current.problemIdentification?.evidence.includes(
					'Exact indexed content hash matched.'
				)
					? 0
					: 0.2,
				maxTokens: current.answerPlan?.requestType === 'problem_hint'
					&& current.answerPlan.depthLevel === 1
					? 700
					: 2200,
				// Final answers must spend the output budget on student-visible text.
				// Some OpenAI-compatible reasoning models otherwise consume maxTokens
				// entirely as hidden reasoning and finish with an empty content stream.
				thinkingMode: 'disabled',
				signal: this._services.signal,
				// If the first streamed attempt returned no text, retry through the
				// adapter's non-streaming completion path. Nothing was shown to the user,
				// and this avoids repeating a provider-specific empty-stream failure.
				onToken: streamImmediately
					? this._services.onAnswerToken
					: undefined,
			});
		} catch (error) {
			// 取消不是失败:照旧上抛,保持"已停止生成"行为。
			if (this._services.signal?.aborted) {
				throw error;
			}
			// 流式失败可能已经把半截内容交给界面(主 provider 断流)。
			// 重试只对"一个字都没流出"的情况安全;已流出则转入兜底,
			// 不能让第二份回答从头再流一遍。
			const streamedOut = this._answerStreamedOut;
			const failureCount = current.modelFailureCount + 1;
			const message = error instanceof Error ? error.message : String(error);
			this._services.onDebug?.('answer_model_failed', {
				stage: 'answer',
				attempt: failureCount,
				streamedOut,
				error: message,
			});
			// 兜底:本地事实提示,确定性生成、含道歉措辞、无内部术语。
			// 已流出半截内容时不清屏,只在其后追加,事实提示仍可交付。
			const hint = buildRecoveryLocalHint({
				symbols: current.workspaceSymbols?.symbols,
				activeFile: current.minimalWorkspaceContext?.catalog.activeEditor
					?.fileName,
			});
			const retryable = failureCount <= 1 && !streamedOut;
			return nextState(state, {
				answer: retryable ? current.answer : hint,
				answerOutcome: retryable ? current.answerOutcome : 'recovery_fallback',
				answerValidation: retryable ? current.answerValidation : {
					valid: true,
					problems: [],
					shouldRegenerate: false,
				},
				modelFailureCount: failureCount,
				recoveryAttempt: retryable
					? { stage: 'answer', message }
					: undefined,
				// answerDelivered 保持 current 值:流式半截时界面已有内容,
				// 兜底提示由 ChatSession 的 answer_fallback_flushed 逻辑补上。
			});
		}
		const answer = completion.content.trim();
		// 引用契约:标记 → 链接/引用清单。无标记时结果与原文一致。
		const finalized = current.workspaceSymbols
			? finalizeAnswerReferences(
				answer,
				current.workspaceSymbols.symbols,
				new Map(current.loadedWorkspaceItems.map((item) => [item.path, item.contentHash])),
				{ workspaceRootUri: this._services.workspaceRootUri }
			)
			: undefined;
		if (finalized && finalized.issues.length > 0) {
			this._services.onDebug?.('answer_reference_issues', finalized.issues);
		}
		// 程序侧块来源自查(证词数据,不渲染):对成品正文做确定性溯源,
		// 供历史清洗的文件绑定与 7.7 校验消费。无栅栏块时结果为空。
		const blockSources = current.workspaceSymbols
			? detectCodeBlockSources(
				finalized ? finalized.markdown : answer,
				current.workspaceSymbols.symbols,
				new Map(current.loadedWorkspaceItems
					.filter((item) => item.kind === 'code')
					.map((item) => [item.path, item.content]))
			)
			: [];
		return nextState(state, {
			answer: finalized ? finalized.markdown : answer,
			// 标记只在缓冲路径下出现;若流式路径意外收到标记,fallback
			// 剥离保证不泄漏(缓冲与否已在上方控制,这里是防御)。
			answerReferences: finalized?.references,
			answerBlockSources: blockSources.length > 0 ? blockSources : undefined,
			answerOutcome: answer ? 'answered' : current.answerOutcome,
			answerRetryCount: current.answerRetryCount + 1,
			// 消费一次性事实纠正指令:重生成完成后清除,grounding_check 复核。
			groundingCorrectionInstruction: undefined,
			// 消费恢复重试标记(成功即清除,防止 validate 边再次路由回来)。
			recoveryAttempt: undefined,
			answerDelivered: current.answerDelivered
				|| Boolean(streamImmediately && this._services.onAnswerToken && answer),
		});
	}

	private async _validate(state: WrappedState): Promise<WrappedState> {
		const current = state.value;
		// 7.8 恢复兜底是程序生成的本地事实提示,不是候选教学回答:
		// 结构校验(提示层级/代码量)对它不适用,复核只会把流程重新推回
		// 已失败的模型调用,形成循环。
		if (current.answerOutcome === 'recovery_fallback') {
			return state;
		}
		let answer = current.answer ?? '';
		let answerValidation = validateStudentAnswer(answer, current.answerPlan!);
		let answerOutcome = current.answerOutcome;
		if (
			(!this._services.onAnswerToken || !answer.trim())
			&& !answerValidation.valid
			&& current.answerRetryCount > MAX_ANSWER_RETRIES
		) {
			const concepts = current.skillRetrievalQuery?.concepts.join('、') || '这个问题';
			answer = current.requestType === 'code_edit'
				? '这次生成的修改没有通过完整性检查，因此我没有把它作为可应用代码提交。请缩小修改范围后再试一次。'
				: `我先不给出可能超过当前提示层级的完整答案。请先围绕“${concepts}”写出你认为的下一步，我再根据你的尝试继续提示。`;
			answerValidation = validateStudentAnswer(answer, current.answerPlan!);
			answerOutcome = 'generic_fallback';
		}
		this._services.onDebug?.('answer_validation', answerValidation);
		return nextState(state, { answer, answerValidation, answerOutcome });
	}

	/** 把已经通过检查的缓冲回答按小块交给原有流式 UI。 */
	private _deliverBufferedAnswer(answer: string): boolean {
		const onToken = this._services.onAnswerToken;
		if (!onToken || !answer) {
			return false;
		}
		const characters = Array.from(answer);
		for (let index = 0; index < characters.length; index += 48) {
			onToken(characters.slice(index, index + 48).join(''));
		}
		return true;
	}

	/**
	 * 回答交付前的工作区复核:重新读取 catalog,对比冻结时的版本索引和
	 * 已加载条目的新鲜度。发现漂移且回答尚未流出时,重载涉及的文件并
	 * 重建快照,回到 build_answer_prompt 按新版本重生成一次(只重试一次,
	 * 防止学生在生成期间持续编辑造成循环)。回答已流出或已用掉重试时,
	 * 只记录漂移事件,不丢弃回答。
	 */
	private async _verifyWorkspace(state: WrappedState): Promise<WrappedState> {
		const current = state.value;
		if (!current.workspaceVersionIndex || !current.workspaceSnapshot) {
			return state;
		}
		let freshMinimal: MinimalWorkspaceContext | undefined;
		try {
			freshMinimal = await this._services.workspaceProvider.getMinimalContext();
		} catch (error) {
			this._services.onDebug?.('workspace_verify_catalog_degraded', String(error));
			return state;
		}
		const freshCatalog = freshMinimal.catalog;
		const changes = diffWorkspaceVersions(
			current.workspaceVersionIndex,
			buildWorkspaceVersionIndex(freshCatalog, [])
		);
		const staleLoaded = current.loadedWorkspaceItems.filter((item) =>
			!this._services.workspaceLoader.isItemFresh(freshCatalog, item)
		);
		const drifted = changes.length > 0 || staleLoaded.length > 0;
		if (!drifted) {
			return state;
		}
		this._services.onDebug?.('workspace_drift_detected', {
			changes,
			staleLoadedPaths: staleLoaded.map((item) => item.path),
			delivered: current.answerDelivered,
			retryUsed: current.workspaceDriftRetryCount > 0,
		});
		const canRegenerate = !current.answerDelivered
			&& current.workspaceDriftRetryCount === 0
			&& staleLoaded.length > 0;
		if (!canRegenerate) {
			return nextState(state, {
				workspaceDriftChanges: changes.length > 0
					? changes
					: staleLoaded.map((item) => ({
						kind: 'modified' as const,
						path: item.path,
					})),
			});
		}
		try {
			const targets = new Set(staleLoaded.map((item) =>
				item.path.replace(/\\/g, '/').toLocaleLowerCase()
			));
			const requests = current.routeAndPlanResult?.workspaceRequests
				.filter((request) => targets.has(
					request.target.replace(/\\/g, '/').toLocaleLowerCase()
				))
				?? [];
			const reloadTargets = requests.length > 0
				? requests
				: [...targets].map((target) => ({
					source: 'workspace' as const,
					target,
					required: false,
					reason: 'Reload after workspace drift.',
				}));
			const reloaded = await this._services.workspaceLoader.load(
				freshCatalog,
				reloadTargets
			);
			const byPath = new Map(current.loadedWorkspaceItems.map((item) => [
				item.path.replace(/\\/g, '/').toLocaleLowerCase(),
				item,
			]));
			for (const item of reloaded) {
				byPath.set(item.path.replace(/\\/g, '/').toLocaleLowerCase(), item);
			}
			const loadedWorkspaceItems = [...byPath.values()];
			const minimalWorkspaceContext: MinimalWorkspaceContext = {
				...current.minimalWorkspaceContext!,
				catalog: freshCatalog,
			};
			return nextState(state, {
				minimalWorkspaceContext,
				loadedWorkspaceItems,
				workspaceSnapshot: buildWorkspaceSnapshot(
					minimalWorkspaceContext,
					loadedWorkspaceItems
				),
				workspaceVersionIndex: buildWorkspaceVersionIndex(
					freshCatalog,
					loadedWorkspaceItems
				),
				workspaceDriftChanges: changes,
				workspaceDriftRetryCount: current.workspaceDriftRetryCount + 1,
				workspaceDriftRegenerate: true,
				answerValidation: undefined,
			});
		} catch (error) {
			this._services.onDebug?.('workspace_drift_reload_degraded', String(error));
			return state;
		}
	}

	/**
	 * 只为高风险回答调用一次短检查器；若发现问题，最多触发一次 Answer 重写。
	 * 第二次仍未通过时，优先采用检查器给出的完整修正版，否则明确说明无法确认。
	 */
	/**
	 * 7.7 结构事实核对:模型回答中"只有注释/是空的/有N行/已写完"类声明
	 * 与冻结工作区的 Tree-sitter 事实确定性比对。冲突且未流出 → 带本地
	 * 事实重生成一次;已流出或重试用尽 → 记录核对结果(不静默改写已见内容)。
	 */
	private async _groundingCheck(state: WrappedState): Promise<WrappedState> {
		const current = state.value;
		// 恢复兜底提示本身由本地事实生成,再过一遍事实核对是纯绕圈。
		if (current.answerOutcome === 'recovery_fallback') {
			return state;
		}
		const symbols = current.workspaceSymbols?.symbols ?? [];
		const result = symbols.length > 0
			? checkAnswerGrounding(current.answer ?? '', symbols)
			: { claims: [], conflicts: [], passed: true };
		const groundingCheck = {
			claims: result.claims,
			conflicts: result.conflicts,
			passed: result.passed,
		};
		if (result.passed) {
			return nextState(state, { groundingCheck });
		}
		this._services.onDebug?.('grounding_conflict', {
			conflicts: result.conflicts.map((claim) => ({
				kind: claim.kind,
				targetId: claim.targetId,
				statedFact: claim.statedFact,
				actualFact: claim.actualFact,
			})),
			answerDelivered: current.answerDelivered,
			retryUsed: current.groundingRetryCount > 0,
		});
		// 已流出的内容不静默替换;缓冲路径下重生成一次,仍冲突交付本地事实提示。
		if (current.answerDelivered || current.groundingRetryCount > 0) {
			if (current.answerDelivered) {
				return nextState(state, { groundingCheck });
			}
			return nextState(state, {
				groundingCheck,
				answer: buildGroundedLocalHint(result.conflicts, symbols),
				answerOutcome: 'grounded_local_hint',
				answerValidation: { valid: true, problems: [], shouldRegenerate: false },
			});
		}
		return nextState(state, {
			groundingCheck,
			groundingRetryCount: current.groundingRetryCount + 1,
			groundingCorrectionInstruction: buildGroundingRetryInstruction(
				result.conflicts,
				symbols
			),
		});
	}

	private async _correctnessCheck(state: WrappedState): Promise<WrappedState> {
		const current = state.value;
		if (
			!current.correctnessCheckRequired
			// 恢复兜底提示不是候选教学回答,没有可复核的算法/约束内容;
			// 再调一次模型复核只会重复刚才失败的调用。
			|| current.answerOutcome === 'recovery_fallback'
		) {
			return state;
		}
		const candidateAnswer = current.answer ?? '';
		try {
			this._assertNotCancelled();
			const allowCorrection = current.answerRetryCount > MAX_ANSWER_RETRIES;
			const messages = new CorrectnessCheckPromptBuilder().build({
				userText: current.request.userText,
				candidateAnswer,
				answerPlan: current.answerPlan!,
				constraints: current.problemConstraints ?? buildFallbackProblemConstraints(current),
				problemCardFacts: current.loadedProblemCardFacts,
				allowCorrection,
			});
			const completion = await this._services.model.complete(messages, {
				label: 'correctness_check',
				temperature: 0,
				maxTokens: allowCorrection ? 2600 : 700,
				jsonMode: true,
				thinkingMode: 'disabled',
				signal: this._services.signal,
			});
			const parsed = correctnessVerificationWireSchema.parse(
				parseJsonObject(completion.content)
			);
			const passed = parsed.p && parsed.s === 'none' && parsed.i.length === 0;
			const verification = {
				checked: true,
				passed,
				severity: passed ? 'none' : parsed.s === 'none' ? 'minor' : parsed.s,
				issues: parsed.i.map((issue) => ({
					category: issue.c,
					description: issue.d,
					correction: issue.f,
				})),
				correctedAnswer: parsed.a,
			} as const;
			this._services.onDebug?.('correctness_verification', verification);

			if (verification.passed) {
				const delivered = current.answerDelivered
					|| this._deliverBufferedAnswer(candidateAnswer);
				return nextState(state, {
					correctnessVerification: verification,
					answerValidation: {
						valid: true,
						problems: [],
						shouldRegenerate: false,
					},
					answerDelivered: delivered,
				});
			}

			const problems = verification.issues.map((issue) =>
				`[${issue.category}] ${issue.description} 修正要求：${issue.correction}`
			);
			if (!allowCorrection) {
				return nextState(state, {
					correctnessVerification: verification,
					answerValidation: {
						valid: false,
						problems: problems.length > 0
							? problems
							: ['候选回答没有通过正确性检查，请重新核对题目约束。'],
						shouldRegenerate: true,
					},
				});
			}

			const correctedAnswer = verification.correctedAnswer?.trim();
			const correctedValidation = correctedAnswer
				? validateStudentAnswer(correctedAnswer, current.answerPlan!)
				: undefined;
			const finalAnswer = correctedAnswer && correctedValidation?.valid
				? correctedAnswer
				: '我暂时无法确认当前答案满足题目的全部约束，因此不想把可能错误的结论直接告诉你。你可以补充完整题面、数据范围或相关代码，我再继续核对。';
			const delivered = current.answerDelivered || this._deliverBufferedAnswer(finalAnswer);
			return nextState(state, {
				answer: finalAnswer,
				answerOutcome: correctedAnswer && correctedValidation?.valid
					? 'answered'
					: 'generic_fallback',
				correctnessVerification: verification,
				answerValidation: {
					valid: true,
					problems,
					shouldRegenerate: false,
				},
				answerDelivered: delivered,
			});
		} catch (error) {
			this._services.onDebug?.('correctness_verification_degraded', String(error));
			const delivered = current.answerDelivered
				|| this._deliverBufferedAnswer(candidateAnswer);
			return nextState(state, {
				correctnessVerification: {
					checked: false,
					passed: false,
					severity: 'none',
					issues: [],
					degraded: true,
				},
				answerDelivered: delivered,
			});
		}
	}
}
