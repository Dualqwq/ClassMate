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
	requestType: 'concept_explanation' | 'runtime_error_help' | 'problem_hint' | 'code_edit',
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
		kind: 'code' | 'text' | 'question';
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
			load: async (_catalog: unknown, requests: Array<{ target: string }>) => onLoad(requests),
			isItemFresh: () => true,
		} as unknown as ClassMateGraphServices['workspaceLoader'],
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
		problemCardIndexLoader: {
			load: async () => ({
				schemaVersion: 1,
				indexVersion: 'test',
				cards: [],
			}),
		} as unknown as ClassMateGraphServices['problemCardIndexLoader'],
		problemCardExtractor: {
			extract: async () => {
				throw new Error('No problem card expected in this test.');
			},
		} as unknown as ClassMateGraphServices['problemCardExtractor'],
		problemCardFactsLoader: {
			select: async () => {
				throw new Error('No structured problem facts expected in this test.');
			},
		} as unknown as ClassMateGraphServices['problemCardFactsLoader'],
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

	it('reloads the workspace instead of reusing a stale route preview', async () => {
		const debugEvents: Array<{ event: string; data: unknown }> = [];
		const model: GraphModelClient = {
			async complete(messages: LLMMessage[]) {
				const text = messages.map((message) => message.content).join('\n');
				if (text.includes('ClassMate RouteAndPlan Mode')) {
					return {
						content: mergedPlan('concept_explanation', [{
							target: 'note.md',
							section: null,
							required: true,
							reason: '读取用户笔记',
						}]),
					};
				}
				return { content: '基于最新缓冲区的回答。' };
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
				activeEditor: {
					fileName: 'note.md',
					uri: 'file:///note.md',
					languageId: 'markdown',
				},
			},
		};
		// Route preview 阶段返回的条目在复核时已经不新鲜(模拟 Route 调用期间
		// 学生继续编辑未保存缓冲区):isItemFresh 对 preview 条目返回 false。
		let previewItem: { path: string; contentHash: string } | undefined;
		let loadCalls = 0;
		const services = createServices(model, minimal, async () => {
			loadCalls++;
			const item = {
				path: 'note.md',
				kind: 'text' as const,
				content: `笔记内容(第 ${loadCalls} 次读取)`,
				contentHash: `hash-${loadCalls}`,
				reason: 'test',
			};
			// Route 阶段(第 1 次)返回的条目视为"之后已被编辑"。
			if (loadCalls === 1) {
				previewItem = item;
			}
			return [item];
		});
		(services.workspaceLoader as unknown as {
			isItemFresh: (
				catalog: unknown,
				item: { path: string; contentHash: string }
			) => boolean;
		}).isItemFresh = (_catalog, item) => item !== previewItem;
		services.onDebug = (event, data) => debugEvents.push({ event, data });

		const result = await new ClassMateGraphRunner(services).run({
			requestId: 'stale-preview',
			conversationId: 'conversation-stale-preview',
			userText: '什么是指针？',
			requestSource: 'conversation',
			conversationHistory: [],
		});

		assert.strictEqual(result.answer, '基于最新缓冲区的回答。');
		assert.ok(loadCalls >= 2, 'stale preview must trigger a reload');
		assert.ok(debugEvents.some((item) =>
			item.event === 'workspace_context_preview_stale_reloaded'
		));
	});

	it('regenerates a buffered answer once when the workspace drifts before delivery', async () => {
		const debugEvents: Array<{ event: string; data: unknown }> = [];
		// 第一次 Answer 生成时工作区是 v1;在 verify_workspace 复核前,
		// provider 换成 v2(hash 变化),期望:重载 + 基于新内容的回答。
		let workspaceContent = 'int value = 1;';
		let workspaceHash = 'hash-v1';
		const model: GraphModelClient = {
			async complete(messages: LLMMessage[]) {
				const text = messages.map((message) => message.content).join('\n');
				if (text.includes('ClassMate RouteAndPlan Mode')) {
					return {
						content: mergedPlan('code_edit', [{
							target: 'monster.h',
							section: null,
							required: true,
							reason: '读取目标文件',
						}]),
					};
				}
				if (text.includes('ClassMate Correctness Check Mode')) {
					return { content: JSON.stringify({ p: true, s: 'none', i: [] }) };
				}
				if (text.includes('ClassMate Problem Constraint Mode')) {
					return { content: JSON.stringify({ h: [], o: [], l: [], e: [], u: [] }) };
				}
				// Answer:根据当前 prompt 里冻结的内容给出可区分、且能通过
				// code_edit 校验(恰好一个完整代码块)的回答。
				return text.includes('int value = 2;')
					? { content: '先补上新的取值:\n\n```cpp\nint takeTurn(int v) {\n    int value = 2;\n    return value;\n}\n```' }
					: { content: '先看旧的取值:\n\n```cpp\nint takeTurn(int v) {\n    int value = 1;\n    return value;\n}\n```' };
			},
		};
		const makeMinimal = (): MinimalWorkspaceContext => ({
			catalog: {
				files: [{
					path: 'monster.h',
					uri: 'file:///monster.h',
					kind: 'code',
					size: workspaceContent.length,
					modifiedAt: 1,
				}],
				questionFiles: [],
			},
		});
		let loadCalls = 0;
		const services = createServices(model, makeMinimal(), async () => {
			loadCalls++;
			return [{
				path: 'monster.h',
				kind: 'code',
				content: workspaceContent,
				contentHash: workspaceHash,
				reason: 'test',
			}];
		});
		// provider 每次返回"当前"目录状态;Answer 第一次生成后切换到 v2。
		let phase = 'before-answer';
		(services.workspaceProvider as {
			getMinimalContext: () => Promise<MinimalWorkspaceContext>;
		}).getMinimalContext = async () => {
			if (phase === 'before-answer') {
				// prepare/route 阶段用 v1;Answer 生成完成后切 v2 模拟学生保存。
				return makeMinimal();
			}
			return {
				...makeMinimal(),
				catalog: {
					...makeMinimal().catalog,
					files: [{
						path: 'monster.h',
						uri: 'file:///monster.h',
						kind: 'code',
						size: 13,
						modifiedAt: 2,
					}],
				},
			};
		};
		const realModel = services.model;
		(services as { model: GraphModelClient }).model = {
			async complete(messages: LLMMessage[], options?: Parameters<GraphModelClient["complete"]>[1]) {
				const text = messages.map((message) => message.content).join('\n');
				if (text.includes('ClassMate Answer Mode')) {
					// 第一次 Answer 完成后进入漂移窗口。
					const result = await realModel.complete(messages, options);
					phase = 'after-answer';
					workspaceContent = 'int value = 2;';
					workspaceHash = 'hash-v2';
					return result;
				}
				return realModel.complete(messages, options);
			},
		};
		(services.workspaceLoader as unknown as {
			isItemFresh: (catalog: unknown, item: { contentHash: string }) => boolean;
		}).isItemFresh = (_catalog, item) => item.contentHash === workspaceHash;
		services.onDebug = (event, data) => debugEvents.push({ event, data });

		const result = await new ClassMateGraphRunner(services).run({
			requestId: 'drift-retry',
			conversationId: 'conversation-drift',
			userText: '怎么改 monster.h',
			requestSource: 'conversation',
			conversationHistory: [],
		});

		assert.ok(result.answer.includes('int value = 2;'), '必须基于重载后的新内容重生成');
		assert.strictEqual(result.state.workspaceDriftRetryCount, 1);
		assert.ok(debugEvents.some((item) => item.event === 'workspace_drift_detected'));
	});

	it('records drift without regenerating once the answer has streamed out', async () => {
		const debugEvents: Array<{ event: string; data: unknown }> = [];
		let workspaceHash = 'hash-v1';
		const model: GraphModelClient = {
			async complete(messages: LLMMessage[]) {
				const text = messages.map((message) => message.content).join('\n');
				if (text.includes('ClassMate RouteAndPlan Mode')) {
					return {
						content: mergedPlan('concept_explanation', [{
							target: 'note.md',
							section: null,
							required: true,
							reason: '读取用户笔记',
						}]),
					};
				}
				return { content: '已经流式展示的回答。' };
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
		};
		const services = createServices(model, minimal, async () => [{
			path: 'note.md',
			kind: 'text',
			content: 'note',
			contentHash: 'hash-v1',
			reason: 'test',
		}]);
		// 回答通过 onAnswerToken 流出 → 不能静默重生成。
		let streamed = false;
		services.onAnswerToken = () => {
			streamed = true;
		};
		(services.workspaceLoader as unknown as {
			isItemFresh: (catalog: unknown, item: { contentHash: string }) => boolean;
		}).isItemFresh = (_catalog, item) => item.contentHash === workspaceHash;
		services.onDebug = (event, data) => debugEvents.push({ event, data });
		// Answer 完成后模拟学生编辑未保存缓冲区:isItemFresh 变为 false。
		// 概念回答走流式路径:mock 在返回前把内容按 token 交给 onToken,
		// 对齐真实适配器的流式行为(answerDelivered 因此为 true)。
		const realModel = services.model;
		(services as { model: GraphModelClient }).model = {
			async complete(messages: LLMMessage[], options?: Parameters<GraphModelClient["complete"]>[1]) {
				const result = await realModel.complete(messages, options);
				const text = messages.map((message) => message.content).join('\n');
				if (text.includes('ClassMate Answer Mode')) {
					for (const token of result.content.split(/(?<=。)/)) {
						options?.onToken?.(token);
					}
					workspaceHash = 'hash-v2';
				}
				return result;
			},
		};

		const result = await new ClassMateGraphRunner(services).run({
			requestId: 'drift-streamed',
			conversationId: 'conversation-drift-streamed',
			userText: '什么是指针？',
			requestSource: 'conversation',
			conversationHistory: [],
		});

		assert.strictEqual(result.answer, '已经流式展示的回答。');
		assert.ok(streamed);
		assert.strictEqual(result.state.workspaceDriftRetryCount, 0);
		assert.ok(debugEvents.some((item) => item.event === 'workspace_drift_detected'));
		assert.ok((result.state.workspaceDriftChanges ?? []).some((change) =>
			change.path === 'note.md'
		));
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
				'identify_problem',
				'load_problem_card',
				'retrieve_skill',
				'freeze_context',
				'extract_constraints',
				'build_answer_prompt',
				'answer',
				'validate',
				'verify_workspace',
				'grounding_check',
				'correctness_check',
			]
		);
		assert.deepStrictEqual(progressNodes, result.nodeTimings.map((timing) => timing.node));
	});

	it('traces the complete state after every executed graph node', async () => {
		const model: GraphModelClient = {
			async complete(messages: LLMMessage[]) {
				const text = messages.map((message) => message.content).join('\n');
				if (text.includes('ClassMate RouteAndPlan Mode')) {
					return { content: mergedPlan('concept_explanation', [{
						target: 'main.cpp',
						required: true,
						reason: 'inspect code',
					}]) };
				}
				return { content: '这段函数把变量加一。' };
			},
		};
		const minimal: MinimalWorkspaceContext = {
			catalog: {
				files: [{
					path: 'main.cpp',
					uri: 'file:///main.cpp',
					kind: 'code',
					size: 20,
					modifiedAt: 1,
				}],
				questionFiles: [],
				activeEditor: {
					fileName: 'main.cpp',
					uri: 'file:///main.cpp',
					languageId: 'cpp',
				},
			},
		};
		const services = createServices(model, minimal, async () => [{
			path: 'main.cpp',
			kind: 'code',
			content: 'void f() { value++; }',
			contentHash: 'main-hash',
			reason: 'test',
		}]);
		const traces: Array<{
			status: string;
			node: string;
			sequence: number;
			inputState: { request: { requestId: string } };
			state?: { workspaceSnapshot?: { snapshotId: string }; answer?: string };
		}> = [];
		services.onNodeTrace = (trace) => traces.push(trace);

		const result = await new ClassMateGraphRunner(services).run({
			requestId: 'node-trace',
			conversationId: 'conversation-node-trace',
			userText: '解释 main.cpp',
			requestSource: 'conversation',
			conversationHistory: [],
		});

		assert.strictEqual(traces.length, result.nodeTimings.length);
		assert.ok(traces.every((trace) => trace.status === 'completed'));
		assert.ok(traces.every((trace) => trace.inputState.request.requestId === 'node-trace'));
		assert.deepStrictEqual(
			traces.map((trace) => `${trace.node}#${trace.sequence}`),
			result.nodeTimings.map((timing) => `${timing.node}#${timing.sequence}`)
		);
		const frozen = traces.find((trace) => trace.node === 'freeze_context');
		assert.ok(frozen?.state?.workspaceSnapshot?.snapshotId);
		const final = traces.at(-1);
		assert.strictEqual(final?.state?.answer, result.state.answer);
	});

	it('does not fail the graph when a node trace sink throws', async () => {
		const originalWarn = console.warn;
		console.warn = () => undefined;
		const model: GraphModelClient = {
			async complete(messages: LLMMessage[]) {
				const text = messages.map((message) => message.content).join('\n');
				return text.includes('ClassMate RouteAndPlan Mode')
					? { content: mergedPlan('concept_explanation') }
					: { content: '图回答仍然可用。' };
			},
		};
		const services = createServices(
			model,
			{ catalog: { files: [], questionFiles: [] } },
			async () => []
		);
		services.onNodeTrace = () => { throw new Error('diagnostic sink failed'); };

		try {
			const result = await new ClassMateGraphRunner(services).run({
				requestId: 'trace-sink-failure',
				conversationId: 'trace-sink-failure',
				userText: '解释指针',
				requestSource: 'conversation',
				conversationHistory: [],
			});
			assert.strictEqual(result.answer, '图回答仍然可用。');
		} finally {
			console.warn = originalWarn;
		}
	});

	it('calls the problem identifier once and supplies one matched card as optional answer context', async () => {
		let identifierCalls = 0;
		const model: GraphModelClient = {
			async complete(messages: LLMMessage[]) {
				const text = messages.map((message) => message.content).join('\n');
				if (text.includes('ClassMate RouteAndPlan Mode')) {
					return { content: mergedPlan('problem_hint') };
				}
				if (text.includes('ClassMate Problem Identifier')) {
					identifierCalls++;
					return {
						content: JSON.stringify({
							id: 'ds.pa1.1-1-1.filename',
							v: null,
							c: 0.95,
							e: ['题号 1-1-1', '标题 filename'],
							r: '题号与标题同时匹配',
						}),
					};
				}
				assert.ok(text.includes('只计算主对角线附近的状态'));
				assert.ok(text.includes('optional clue'));
				return { content: '可以先想：答案不超过 K 时，哪些 DP 状态才可能用到？' };
			},
		};
		const minimal: MinimalWorkspaceContext = {
			catalog: {
				files: [{
					path: 'CST数据结构/PA1/9489-CST 1-1-1 filename/question.md',
					uri: 'file:///question.md',
					kind: 'question',
					size: 100,
					modifiedAt: 1,
				}],
				questionFiles: ['CST数据结构/PA1/9489-CST 1-1-1 filename/question.md'],
				activeEditor: {
					fileName: 'CST数据结构/PA1/9489-CST 1-1-1 filename/question.md',
					uri: 'file:///question.md',
					languageId: 'markdown',
				},
			},
			questionFile: 'CST数据结构/PA1/9489-CST 1-1-1 filename/question.md',
		};
		const services = createServices(model, minimal, async () => [{
			path: 'CST数据结构/PA1/9489-CST 1-1-1 filename/question.md',
			kind: 'question',
			content: '# filename\n只能插入和删除，判断距离是否不超过K。',
			contentHash: 'question-hash',
			reason: 'test',
		}]);
		const testCard = {
			id: 'ds.pa1.1-1-1.filename',
			course: 'data-structures' as const,
			series: 'PA1',
			number: '1-1-1',
			ojIds: ['9489'],
			title: 'filename',
			aliases: ['文件名'],
			source: {
				path: 'references/data-structure-pa1-cards.md',
				headingPath: ['PA1 1-1-1 filename'],
			},
			fingerprints: {
				pathTokens: ['PA1', '1-1-1', '9489', 'filename'],
				titleTokens: ['filename'],
				distinctivePhrases: ['只能插入和删除'],
				concepts: ['动态规划'],
				codeMarkers: [],
				contentHashes: [],
			},
			variants: [],
		};
		services.problemCardIndexLoader = {
			load: async () => ({
				schemaVersion: 1,
				indexVersion: 'test',
				cards: [testCard],
			}),
		} as unknown as ClassMateGraphServices['problemCardIndexLoader'];
		services.problemCardExtractor = {
			extract: async () => ({
				cardId: testCard.id,
				content: '只计算主对角线附近的状态；卡片不是当前工作区事实。',
				contentHash: 'card-hash',
			}),
		} as unknown as ClassMateGraphServices['problemCardExtractor'];
		services.problemCardFactsLoader = {
			select: async () => ({
				card: {
					id: testCard.id,
					kind: 'solution',
					primaryConclusion: '只计算主对角线附近宽度为 K 的状态。',
					evidence: ['只关心距离是否不超过 K。'],
					complexity: { time: 'O((N + M)K)', space: 'O(K)' },
					pitfalls: ['滚动数组状态要重新初始化。'],
					verifiedTests: [],
					rejectedClaims: ['不需要完整二维 DP。'],
					answerRequirements: ['先解释带状范围。'],
				},
			}),
		} as unknown as ClassMateGraphServices['problemCardFactsLoader'];

		const result = await new ClassMateGraphRunner(services).run({
			requestId: 'problem-card',
			conversationId: 'conversation-card',
			userText: 'filename这题没思路，二维dp开不下怎么办？',
			requestSource: 'conversation',
			conversationHistory: [],
		});

		assert.strictEqual(identifierCalls, 1);
		assert.strictEqual(
			result.state.problemIdentification?.cardId,
			'ds.pa1.1-1-1.filename'
		);
		assert.strictEqual(result.state.loadedProblemCard?.contentHash, 'card-hash');
		assert.strictEqual(
			result.state.conversationWorkspaceContext?.problemCardId,
			'ds.pa1.1-1-1.filename'
		);

		const followUp = await new ClassMateGraphRunner(services).run({
			requestId: 'problem-card-follow-up',
			conversationId: 'conversation-card',
			userText: '那时间复杂度是多少？',
			requestSource: 'conversation',
			conversationHistory: [
				{ role: 'user', content: 'filename这题没思路，二维dp开不下怎么办？' },
				{ role: 'assistant', content: result.answer },
			],
			previousWorkspaceContext: result.state.conversationWorkspaceContext,
		});
		assert.strictEqual(identifierCalls, 1);
		assert.strictEqual(followUp.state.problemIdentification?.reused, true);
	});

	it('retries once when a streaming answer finishes without producing any text', async () => {
		let answerCalls = 0;
		const streamedAttempts: boolean[] = [];
		const thinkingModes: Array<'enabled' | 'disabled' | undefined> = [];
		const model: GraphModelClient = {
			async complete(messages: LLMMessage[], options) {
				const text = messages.map((message) => message.content).join('\n');
				if (text.includes('ClassMate RouteAndPlan Mode')) {
					return { content: mergedPlan('concept_explanation') };
				}
				answerCalls++;
				streamedAttempts.push(Boolean(options?.onToken));
				thinkingModes.push(options?.thinkingMode);
				return {
					content: answerCalls === 1
						? ''
						: '指针可以先理解成“保存地址的变量”。',
				};
			},
		};
		const minimal: MinimalWorkspaceContext = {
			catalog: {
				files: [],
				questionFiles: [],
			},
		};
		const services = createServices(model, minimal, async () => []);
		services.onAnswerToken = () => undefined;

		const result = await new ClassMateGraphRunner(services).run({
			requestId: 'empty-stream-retry',
			conversationId: 'empty-stream-retry',
			userText: '什么是指针？',
			requestSource: 'conversation',
			conversationHistory: [],
		});

		assert.strictEqual(answerCalls, 2);
		assert.deepStrictEqual(streamedAttempts, [true, false]);
		assert.deepStrictEqual(thinkingModes, ['disabled', 'disabled']);
		assert.strictEqual(result.answer, '指针可以先理解成“保存地址的变量”。');
		assert.strictEqual(result.state.answerOutcome, 'answered');
	});

	it('reports a generic fallback structurally after empty answer retries are exhausted', async () => {
		const model: GraphModelClient = {
			async complete(messages: LLMMessage[]) {
				const text = messages.map((message) => message.content).join('\n');
				if (text.includes('ClassMate RouteAndPlan Mode')) {
					return { content: mergedPlan('concept_explanation') };
				}
				return { content: '' };
			},
		};
		const services = createServices(model, {
			catalog: { files: [], questionFiles: [] },
		}, async () => []);

		const result = await new ClassMateGraphRunner(services).run({
			requestId: 'empty-answer-fallback',
			conversationId: 'empty-answer-fallback',
			userText: '什么是指针？',
			requestSource: 'conversation',
			conversationHistory: [],
		});

		assert.strictEqual(result.state.answerOutcome, 'generic_fallback');
		assert.ok(result.answer.length > 0);
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

	it('expands a problem hint into every related file in the assignment directory', async () => {
		const relatedFiles = [
			'homework/question.md',
			'homework/main.cpp',
			'homework/Editor.h',
			'homework/Editor.cpp',
			'homework/TextProcessor.h',
			'homework/TextProcessor.cpp',
			'homework/Makefile',
			'homework/sample.txt',
		];
		const unrelatedFile = 'other-homework/main.cpp';
		const minimal: MinimalWorkspaceContext = {
			catalog: {
				files: [...relatedFiles, unrelatedFile].map((filePath) => ({
					path: filePath,
					uri: `file:///${filePath}`,
					kind: filePath.endsWith('question.md')
						? 'question' as const
						: filePath.endsWith('Makefile')
							? 'build' as const
							: filePath.endsWith('.txt')
								? 'text' as const
								: 'code' as const,
					size: 20,
					modifiedAt: 1,
				})),
				questionFiles: ['homework/question.md'],
				activeEditor: {
					fileName: 'homework/main.cpp',
					uri: 'file:///homework/main.cpp',
					languageId: 'cpp',
				},
			},
			questionFile: 'homework/question.md',
		};
		const model: GraphModelClient = {
			async complete(messages: LLMMessage[]) {
				const text = messages.map((message) => message.content).join('\n');
				if (text.includes('ClassMate RouteAndPlan Mode')) {
					return { content: mergedPlan('problem_hint') };
				}
				return { content: '先找出题目要求维护的核心状态，再考虑每个操作如何改变它。' };
			},
		};
		const services = createServices(model, minimal, async (requests) => {
			assert.deepStrictEqual(
				new Set(requests.map((request) => request.target)),
				new Set(relatedFiles)
			);
			return requests.map((request) => ({
				path: request.target,
				kind: 'code',
				content: `content of ${request.target}`,
				contentHash: `hash-${request.target}`,
				reason: 'test',
			}));
		});

		const result = await new ClassMateGraphRunner(services).run({
			requestId: 'problem-context',
			conversationId: 'conversation-problem',
			userText: '这题下一步怎么写？',
			requestSource: 'conversation',
			conversationHistory: [],
		});

		assert.strictEqual(result.state.contextMode, 'problem_context');
		assert.strictEqual(result.state.loadedWorkspaceItems.length, 8);
		assert.ok(!result.state.loadedWorkspaceItems.some(
			(item) => item.path === unrelatedFile
		));
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

	it('extracts constraints and checks a high-risk answer before delivering it', async () => {
		const events: string[] = [];
		let constraintCalls = 0;
		let checkCalls = 0;
		const model: GraphModelClient = {
			async complete(messages: LLMMessage[]) {
				const text = messages.map((message) => message.content).join('\n');
				if (text.includes('ClassMate RouteAndPlan Mode')) {
					return { content: mergedPlan('runtime_error_help', [{
						target: 'main.cpp',
						required: true,
						reason: '检查越界',
					}]) };
				}
				if (text.includes('ClassMate Problem Constraint Extraction')) {
					constraintCalls++;
					events.push('constraints');
					return { content: JSON.stringify({
						h: ['下标必须位于数组范围内'],
						o: ['访问数组元素'],
						l: ['数组长度为 n'],
						e: ['负数下标不能访问数组'],
						u: [],
						p: ['main.cpp', '../outside.txt'],
					}) };
				}
				if (text.includes('ClassMate Lightweight Correctness Check')) {
					checkCalls++;
					events.push('check');
					return { content: JSON.stringify({ p: true, s: 'none', i: [] }) };
				}
				events.push('answer');
				return { content: '进入循环前先拒绝负数下标，避免指针一直向后移动。' };
			},
		};
		const minimal: MinimalWorkspaceContext = {
			catalog: {
				files: [{
					path: 'main.cpp',
					uri: 'file:///main.cpp',
					kind: 'code',
					size: 80,
					modifiedAt: 1,
				}],
				questionFiles: [],
			},
		};
		const services = createServices(model, minimal, async () => [{
			path: 'main.cpp',
			kind: 'code',
			content: 'while (n != index) { n++; current = current->next; }',
			contentHash: 'main-hash',
			reason: 'test',
		}]);
		services.onAnswerToken = (token) => {
			if (token) { events.push('emit'); }
		};

		const result = await new ClassMateGraphRunner(services).run({
			requestId: 'correctness-pass',
			conversationId: 'correctness-pass',
			userText: 'at(-1) 为什么会一直循环？',
			requestSource: 'conversation',
			conversationHistory: [],
		});

		assert.strictEqual(constraintCalls, 1);
		assert.strictEqual(checkCalls, 1);
		assert.strictEqual(result.state.correctnessVerification?.passed, true);
		assert.deepStrictEqual(result.state.problemConstraints?.evidencePaths, ['main.cpp']);
		assert.ok(events.indexOf('check') < events.indexOf('emit'));
	});

	it('regenerates a high-risk answer once when the correctness check finds an error', async () => {
		let answerCalls = 0;
		let checkCalls = 0;
		let delivered = '';
		const model: GraphModelClient = {
			async complete(messages: LLMMessage[]) {
				const text = messages.map((message) => message.content).join('\n');
				if (text.includes('ClassMate RouteAndPlan Mode')) {
					return { content: mergedPlan('runtime_error_help') };
				}
				if (text.includes('ClassMate Problem Constraint Extraction')) {
					return { content: JSON.stringify({
						h: ['不能访问负数下标'], o: [], l: [], e: [], u: [], p: [],
					}) };
				}
				if (text.includes('ClassMate Lightweight Correctness Check')) {
					checkCalls++;
					if (checkCalls === 1) {
						return { content: JSON.stringify({
							p: false,
							s: 'major',
							i: [{
								c: 'constraint_ignored',
								d: '回答允许了负数下标。',
								f: '进入循环前拒绝负数下标。',
							}],
						}) };
					}
					return { content: JSON.stringify({ p: true, s: 'none', i: [] }) };
				}
				answerCalls++;
				return { content: answerCalls === 1
					? '负数下标可以继续向后找。'
					: '进入循环前先判断 index 是否小于 0；若小于 0 就直接报错或返回。' };
			},
		};
		const minimal: MinimalWorkspaceContext = {
			catalog: { files: [], questionFiles: [] },
		};
		const services = createServices(model, minimal, async () => []);
		services.onAnswerToken = (token) => { delivered += token; };

		const result = await new ClassMateGraphRunner(services).run({
			requestId: 'correctness-retry',
			conversationId: 'correctness-retry',
			userText: 'at(-1) 为什么会崩？',
			requestSource: 'conversation',
			conversationHistory: [],
		});

		assert.strictEqual(answerCalls, 2);
		assert.strictEqual(checkCalls, 2);
		assert.ok(!delivered.includes('可以继续向后找'));
		assert.strictEqual(delivered, result.answer);
		assert.strictEqual(result.state.correctnessVerification?.passed, true);
	});
});

describe('grounding_check (7.7 结构事实核对)', () => {
	const MONSTER_ACTIVE = [
		'#pragma once',
		'class Monster {',
		'public:',
		'    void takeTurn()',
		'    {',
		'        std::cout << "turn";',
		'        doWork();',
		'    }',
		'};',
	].join('\n');

	function groundingServices(model: GraphModelClient): ClassMateGraphServices {
		const services = createServices(model, {
			catalog: {
				files: [{
					path: 'monster.h',
					uri: 'file:///monster.h',
					kind: 'code',
					size: 10,
					modifiedAt: 1,
				}],
				questionFiles: [],
				activeEditor: {
					fileName: 'monster.h',
					uri: 'file:///monster.h',
					languageId: 'cpp',
				},
			},
		}, async () => [{
			path: 'monster.h',
			kind: 'code' as const,
			content: MONSTER_ACTIVE,
			contentHash: 'hash-active',
			reason: 'test',
		}]);
		return services;
	}

	function groundingModel(plannedAnswers: string[]): GraphModelClient {
		let answerIndex = 0;
		return {
			async complete(messages: LLMMessage[]) {
				const text = messages.map((message) => message.content).join('\n');
				if (text.includes('ClassMate RouteAndPlan Mode')) {
					return {
						content: mergedPlan('concept_explanation', [{
							target: 'monster.h',
							section: null,
							required: true,
							reason: '读取目标文件',
						}]),
					};
				}
				// Answer 提示里也含 "Constraints" 标题:必须先按 Answer 专属
				// 标题识别 answer 调用,再判其余 mode。
				if (text.includes('ClassMate Answer Mode')) {
					const answer = plannedAnswers[Math.min(answerIndex, plannedAnswers.length - 1)];
					answerIndex++;
					return { content: answer };
				}
				if (text.includes('ClassMate Correctness Check Mode')) {
					return { content: JSON.stringify({ p: true, s: 'none', i: [] }) };
				}
				if (text.includes('ClassMate Problem Constraint Mode')) {
					return { content: JSON.stringify({ h: [], o: [], l: [], e: [], u: [] }) };
				}
				return { content: '' };
			},
		};
	}

	it('T5: regenerates once with local facts when the answer contradicts active code', async () => {
		const model = groundingModel([
			'明白了，你是把 `takeTurn` 里的代码注释掉了，函数体只剩注释。请恢复它们。',
			'抱歉说错了：`takeTurn` 当前已有实际代码（第 4–8 行）。我们直接看它的输出逻辑。',
		]);
		const result = await new ClassMateGraphRunner(groundingServices(model)).run({
			requestId: 'grounding-t5',
			conversationId: 'conversation-grounding-t5',
			userText: '保存了呀只是注释了而已',
			requestSource: 'conversation',
			conversationHistory: [],
		});
		assert.ok(!result.answer.includes('只剩注释'), '错误事实不得直达');
		assert.ok(result.answer.includes('已有实际代码'), '最终交付以事实为准');
		assert.strictEqual(result.state.groundingCheck?.passed, true, '重生成后复核通过');
		assert.strictEqual(result.state.groundingRetryCount, 1);
		assert.strictEqual(result.state.answerOutcome, 'answered');
	});

	it('falls back to the grounded local hint when regeneration still conflicts', async () => {
		const model = groundingModel([
			'`takeTurn` 函数体是空的，什么都没做。',
			'是的，`takeTurn` 只有注释，是空的。',
		]);
		const result = await new ClassMateGraphRunner(groundingServices(model)).run({
			requestId: 'grounding-hint',
			conversationId: 'conversation-grounding-hint',
			userText: 'takeTurn 现在怎么样了',
			requestSource: 'conversation',
			conversationHistory: [],
		});
		assert.strictEqual(result.state.answerOutcome, 'grounded_local_hint');
		assert.ok(result.answer.includes('抱歉'), '本地事实提示须含道歉措辞');
		assert.ok(result.answer.includes('monster.h'), '提示须指向具体文件');
		assert.ok(!/(Frozen workspace data|清单|信封|校验)/.test(result.answer), '不得出现内部术语');
	});
});
