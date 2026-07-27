import * as assert from 'assert';
import { describe, it } from 'mocha';
import {
	ClassMateGraphRunner,
	findExplicitWorkspaceRequests,
	type ClassMateGraphServices,
} from '../graph/ClassMateGraphRunner';
import type { GraphModelClient } from '../graph/modelClient';
import type { LLMMessage } from '../llm/types';
import type { SkillCandidate, SkillGraph } from '../skill/types';
import type { MinimalWorkspaceContext } from '../workspace/types';

function createGraph(): SkillGraph {
	return {
		schemaVersion: 1,
		graphVersion: 'test',
		nodes: [{
			id: 'cpp.pointer',
			title: '指针',
			source: { path: 'references/concepts.md', headingPath: ['指针'] },
			concepts: ['指针'],
			aliases: ['pointer'],
			requestTypes: ['concept_explanation', 'runtime_error_help'],
			purposes: ['definition', 'example', 'debug'],
			learnerLevels: ['beginner'],
			relations: [],
		}],
	};
}

function mergedPlan(
	requestType: 'concept_explanation' | 'runtime_error_help',
	workspaceRequests: Array<{
		target: string;
		section?: string | null;
		required: boolean;
		reason: string;
	}> = []
): string {
	return JSON.stringify({
		t: requestType,
		f: workspaceRequests.map((request) => request.target),
		s: ['cpp.pointer'],
		d: 1,
		p: ['定位', '解释'],
		i: [],
		a: ['完整代码'],
		code: false,
		q: ['指针'],
		u: ['debug'],
	});
}

function createServices(
	model: GraphModelClient,
	minimal: MinimalWorkspaceContext,
	onLoad: (requests: Array<{ target: string }>) => Promise<Array<{
		path: string;
		kind: 'code' | 'text';
		content: string;
		contentHash: string;
		reason: string;
	}>>
): ClassMateGraphServices {
	const graph = createGraph();
	return {
		model,
		workspaceProvider: {
			getMinimalContext: async () => minimal,
		} as ClassMateGraphServices['workspaceProvider'],
		workspaceLoader: {
			load: async (_catalog, requests) => onLoad(requests),
		} as ClassMateGraphServices['workspaceLoader'],
		skillContentLoader: {
			loadText: async (file: string) => `content of ${file}`,
		} as ClassMateGraphServices['skillContentLoader'],
		skillGraphLoader: {
			load: async () => graph,
		} as ClassMateGraphServices['skillGraphLoader'],
		skillSectionExtractor: {
			extractAll: async (candidates: SkillCandidate[]) => candidates.map((candidate) => ({
				nodeId: candidate.node.id,
				path: candidate.node.source.path,
				headingPath: candidate.node.source.headingPath,
				content: '指针保存一个内存地址。',
				score: candidate.score,
				matchedBy: ['test'],
				relationsUsed: [],
				contentHash: 'skill-hash',
			})),
		} as unknown as ClassMateGraphServices['skillSectionExtractor'],
	};
}

describe('ClassMate LangGraph runner', () => {
	it('loads a workspace file explicitly named by the user even when planning forgets it', () => {
		const requests = findExplicitWorkspaceRequests(
			'请检查当前 task_list.cpp 中的 at(-1)',
			[
				{ path: 'question.md' },
				{ path: 'src/task_list.cpp' },
				{ path: 'src/task_list.h' },
			]
		);

		assert.deepStrictEqual(requests.map((request) => request.target), ['src/task_list.cpp']);
		assert.strictEqual(requests[0].source, 'workspace');
		assert.strictEqual(requests[0].required, true);
	});

	it('plans once, loads context once, retrieves selected Skill, and answers', async () => {
		let routeAndPlanCalls = 0;
		let workspaceLoadCalls = 0;
		const progressNodes: string[] = [];
		const model: GraphModelClient = {
			async complete(messages: LLMMessage[]) {
				const text = messages.map((message) => message.content).join('\n');
				if (text.includes('ClassMate RouteAndPlan Mode')) {
					routeAndPlanCalls++;
					return {
						content: mergedPlan('concept_explanation', [{
							target: 'note.md',
							section: null,
							required: true,
							reason: '读取用户笔记',
						}]),
					};
				}
				return { content: '指针可以先理解成“保存地址的变量”。' };
			},
		};
		const minimal: MinimalWorkspaceContext = {
			catalog: {
				files: [{
					path: 'note.md',
					uri: 'file:///note.md',
					kind: 'text',
					size: 20,
					modifiedAt: 1,
				}],
				questionFiles: [],
			},
			// 这些正文不应进入 RouteAndPlan 提示词。
			activeFilePreview: 'SHOULD_NOT_BE_IN_PLANNING_PROMPT',
			questionText: 'SHOULD_NOT_BE_IN_PLANNING_PROMPT_EITHER',
		};
		const services = createServices(model, minimal, async (requests) => {
			workspaceLoadCalls++;
			assert.deepStrictEqual(requests.map((request) => request.target), ['note.md']);
			return [{
				path: 'note.md',
				kind: 'text',
				content: '这是用户的指针笔记。',
				contentHash: 'note-hash',
				reason: 'test',
			}];
		});
		services.onProgress = (node) => progressNodes.push(node);

		const result = await new ClassMateGraphRunner(services).run({
			requestId: 'request-1',
			conversationId: 'conversation-1',
			userText: '什么是指针？',
			requestSource: 'conversation',
			conversationHistory: [],
		});

		assert.strictEqual(result.answer, '指针可以先理解成“保存地址的变量”。');
		assert.strictEqual(routeAndPlanCalls, 1);
		assert.strictEqual(workspaceLoadCalls, 1);
		assert.strictEqual(result.state.routeAndPlanAttemptCount, 1);
		assert.strictEqual(result.state.loadedWorkspaceItems.length, 1);
		assert.deepStrictEqual(result.state.skillRequests.map((item) => item.id), ['cpp.pointer']);
		assert.strictEqual(result.state.requestTypeFrozen, true);
		assert.strictEqual(result.state.answerContextFrozen, true);
		assert.strictEqual(result.state.answerValidation?.valid, true);
		assert.deepStrictEqual(
			result.nodeTimings.map((timing) => timing.node),
			[
				'prepare',
				'route_and_plan',
				'load_context',
				'freeze_route',
				'retrieve_skill',
				'freeze_context',
				'build_answer_prompt',
				'answer',
				'validate',
			]
		);
		assert.deepStrictEqual(progressNodes, result.nodeTimings.map((timing) => timing.node));
	});

	it('does not rerun planning after loading requested context', async () => {
		let routeAndPlanCalls = 0;
		const model: GraphModelClient = {
			async complete(messages: LLMMessage[]) {
				const text = messages.map((message) => message.content).join('\n');
				if (text.includes('ClassMate RouteAndPlan Mode')) {
					routeAndPlanCalls++;
					return {
						content: mergedPlan('runtime_error_help', [{
							target: 'task_list.cpp',
							required: true,
							reason: '检查出错函数',
						}]),
					};
				}
				return { content: '进入循环前先检查负数下标。' };
			},
		};
		const minimal: MinimalWorkspaceContext = {
			catalog: {
				files: [{
					path: 'task_list.cpp',
					uri: 'file:///task_list.cpp',
					kind: 'code',
					size: 20,
					modifiedAt: 1,
				}],
				questionFiles: [],
			},
		};
		const services = createServices(model, minimal, async () => [{
			path: 'task_list.cpp',
			kind: 'code',
			content: 'while (n != index) { n++; current = current->next; }',
			contentHash: 'code-hash',
			reason: 'test',
		}]);

		const result = await new ClassMateGraphRunner(services).run({
			requestId: 'single-planning-request',
			conversationId: 'conversation-2',
			userText: 'Why does at(-1) loop forever?',
			requestSource: 'conversation',
			conversationHistory: [],
		});

		assert.strictEqual(routeAndPlanCalls, 1);
		assert.strictEqual(result.state.routeAndPlanAttemptCount, 1);
		assert.strictEqual(result.state.processedContextRequestKeys.length, 1);
	});

	it('rejects workspace paths and Skill IDs that are absent from supplied directories', async () => {
		const debugEvents: Array<{ event: string; data: unknown }> = [];
		const model: GraphModelClient = {
			async complete(messages: LLMMessage[]) {
				const text = messages.map((message) => message.content).join('\n');
				if (text.includes('ClassMate RouteAndPlan Mode')) {
					const parsed = JSON.parse(mergedPlan('concept_explanation'));
					parsed.f = ['../secret.txt'];
					parsed.s = ['missing.skill'];
					return { content: JSON.stringify(parsed) };
				}
				return { content: '这里只解释已获得的信息。' };
			},
		};
		const minimal: MinimalWorkspaceContext = {
			catalog: { files: [], questionFiles: [] },
		};
		const services = createServices(model, minimal, async (requests) => {
			assert.strictEqual(requests.length, 0);
			return [];
		});
		services.onDebug = (event, data) => debugEvents.push({ event, data });

		const result = await new ClassMateGraphRunner(services).run({
			requestId: 'invalid-selection',
			conversationId: 'conversation-3',
			userText: '解释指针',
			requestSource: 'conversation',
			conversationHistory: [],
		});

		assert.strictEqual(result.state.skillRequests.length, 0);
		assert.ok(debugEvents.some((item) =>
			item.event === 'route_and_plan_invalid_workspace_requests'
		));
		assert.ok(debugEvents.some((item) =>
			item.event === 'route_and_plan_invalid_skill_requests'
		));
	});
});
