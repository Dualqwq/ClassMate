import * as assert from 'assert';
import { describe, it } from 'mocha';
import { AdapterGraphModelClient, FallbackGraphModelClient } from '../graph/modelClient';
import type {
	LLMAdapter,
	LLMCompletionResult,
	LLMRequest,
	LLMStreamCallbacks,
} from '../llm/types';

describe('AdapterGraphModelClient streaming', () => {
	it('uses non-streaming completion for RouteAndPlan JSON calls', async () => {
		let completeCalls = 0;
		let streamCalls = 0;
		const adapter: LLMAdapter = {
			name: 'test',
			buildRequest: (request) => request,
			streamResponse: () => { streamCalls++; },
			complete: async (): Promise<LLMCompletionResult> => {
				completeCalls++;
				return { content: '{"ok":true}' };
			},
		};
		const client = new AdapterGraphModelClient(adapter);
		const result = await client.complete([{ role: 'user', content: 'plan' }]);

		assert.strictEqual(result.content, '{"ok":true}');
		assert.strictEqual(completeCalls, 1);
		assert.strictEqual(streamCalls, 0);
	});

	it('forces the final Answer through the streaming adapter when onToken is supplied', async () => {
		let completeCalls = 0;
		let streamCalls = 0;
		const received: string[] = [];
		const usageLabels: Array<string | undefined> = [];
		const adapter: LLMAdapter = {
			name: 'test',
			buildRequest: (request: LLMRequest) => request,
			streamResponse: (_request: unknown, callbacks: LLMStreamCallbacks) => {
				streamCalls++;
				callbacks.onToken('你');
				callbacks.onToken('好');
				callbacks.onUsage?.({ inputTokens: 10, outputTokens: 2, totalTokens: 12 });
				callbacks.onComplete?.();
			},
			complete: async () => {
				completeCalls++;
				return { content: 'non-streaming' };
			},
		};
		const client = new AdapterGraphModelClient(
			adapter,
			undefined,
			(_usage, label) => usageLabels.push(label)
		);
		const result = await client.complete(
			[{ role: 'user', content: 'answer' }],
			{ label: 'answer', onToken: (token) => received.push(token) }
		);

		assert.strictEqual(result.content, '你好');
		assert.deepStrictEqual(received, ['你', '好']);
		assert.strictEqual(streamCalls, 1);
		assert.strictEqual(completeCalls, 0);
		assert.strictEqual(result.usage?.totalTokens, 12);
		assert.deepStrictEqual(usageLabels, ['answer']);
	});

	it('reports each request with its messages through onRequest', async () => {
		const adapter: LLMAdapter = {
			name: 'test',
			buildRequest: (request: LLMRequest) => request,
			streamResponse: () => undefined,
			complete: async (): Promise<LLMCompletionResult> => ({ content: '{}' }),
		};
		const requests: Array<{ label?: string; messages: LLMRequest['messages'] }> = [];
		const client = new AdapterGraphModelClient(
			adapter,
			undefined,
			undefined,
			(messages, label) => requests.push({ messages, label })
		);

		await client.complete(
			[{ role: 'user', content: 'plan' }],
			{ label: 'route_and_plan' }
		);
		await client.complete(
			[{ role: 'user', content: 'answer' }],
			{ label: 'answer' }
		);

		assert.strictEqual(requests.length, 2);
		assert.strictEqual(requests[0].label, 'route_and_plan');
		assert.strictEqual(requests[0].messages[0].content, 'plan');
		assert.strictEqual(requests[1].label, 'answer');
		assert.strictEqual(requests[1].messages[0].content, 'answer');
	});

	it('traces the exact model options and response for each call', async () => {
		const adapter: LLMAdapter = {
			name: 'test',
			buildRequest: (request: LLMRequest) => request,
			streamResponse: (_request: unknown, callbacks: LLMStreamCallbacks) => {
				callbacks.onToken('final answer');
				callbacks.onUsage?.({ inputTokens: 8, outputTokens: 2, totalTokens: 10 });
				callbacks.onComplete?.();
			},
		};
		const traces: Array<Record<string, unknown>> = [];
		const client = new AdapterGraphModelClient(
			adapter,
			'deepseek-v4-flash',
			undefined,
			undefined,
			(trace) => traces.push(trace as unknown as Record<string, unknown>)
		);

		await client.complete(
			[{ role: 'user', content: 'answer this' }],
			{
				label: 'answer',
				temperature: 0.2,
				maxTokens: 700,
				thinkingMode: 'disabled',
				onToken: () => undefined,
			}
		);

		assert.strictEqual(traces.length, 2);
		assert.deepStrictEqual(
			{
				phase: traces[0].phase,
				label: traces[0].label,
				model: traces[0].model,
				messages: traces[0].messages,
				options: traces[0].options,
			},
			{
				phase: 'request',
				label: 'answer',
				model: 'deepseek-v4-flash',
				messages: [{ role: 'user', content: 'answer this' }],
				options: {
					temperature: 0.2,
					maxTokens: 700,
					jsonMode: false,
					thinkingMode: 'disabled',
					streaming: true,
				},
			}
		);
		assert.strictEqual(traces[1].phase, 'response');
		assert.strictEqual(traces[1].callId, traces[0].callId);
		assert.strictEqual(traces[1].content, 'final answer');
		assert.deepStrictEqual(traces[1].usage, {
			inputTokens: 8,
			outputTokens: 2,
			totalTokens: 10,
		});
	});

	it('does not fail the model call when a diagnostic trace sink throws', async () => {
		const originalWarn = console.warn;
		console.warn = () => undefined;
		const adapter: LLMAdapter = {
			name: 'test',
			buildRequest: (request: LLMRequest) => request,
			streamResponse: () => undefined,
			complete: async () => ({ content: 'answer survives diagnostics' }),
		};
		const client = new AdapterGraphModelClient(
			adapter,
			undefined,
			undefined,
			undefined,
			() => { throw new Error('diagnostic sink failed'); }
		);

		try {
			const result = await client.complete([{ role: 'user', content: 'question' }]);
			assert.strictEqual(result.content, 'answer survives diagnostics');
		} finally {
			console.warn = originalWarn;
		}
	});
});

describe('AdapterGraphModelClient signal 取消传导(run17 取证回归)', () => {
	it('非流式路径把 signal 传进 LLMRequest,挂起中的请求随 abort 及时失败', async () => {
		const controller = new AbortController();
		let seenSignal: AbortSignal | undefined;
		let completeEntered = 0;
		const adapter: LLMAdapter = {
			name: 'test',
			buildRequest: (request) => request,
			streamResponse: () => undefined,
			complete: async (request: LLMRequest) => {
				completeEntered++;
				seenSignal = request.signal;
				// 模拟挂起的 HTTP:abort 前永不 resolve。
				return new Promise<LLMCompletionResult>((_resolve, reject) => {
					request.signal?.addEventListener('abort', () => {
						reject(new Error('ClassMate request was cancelled.'));
					}, { once: true });
				});
			},
		};
		const client = new AdapterGraphModelClient(adapter);
		const pending = client.complete(
			[{ role: 'user', content: 'plan' }],
			{ label: 'route_and_plan', signal: controller.signal }
		);
		setTimeout(() => controller.abort(), 10);
		await assert.rejects(() => pending, /cancelled/);
		assert.strictEqual(completeEntered, 1);
		assert.strictEqual(seenSignal, controller.signal, 'signal 必须传入适配器请求');
	});

	it('流式路径把 signal 作为第三参传给 streamResponse', async () => {
		const controller = new AbortController();
		let seenSignal: AbortSignal | undefined;
		const adapter: LLMAdapter = {
			name: 'test',
			buildRequest: (request) => request,
			streamResponse: (_request, _callbacks, signal) => {
				seenSignal = signal;
				// 模拟 SDK:收到 abort 才结束流。
				signal?.addEventListener('abort', () => {
					_callbacks.onError?.(new Error('ClassMate request was cancelled.'));
				}, { once: true });
			},
		};
		const client = new AdapterGraphModelClient(adapter);
		const pending = client.complete(
			[{ role: 'user', content: 'answer' }],
			{ label: 'answer', signal: controller.signal, onToken: () => undefined }
		);
		setTimeout(() => controller.abort(), 10);
		await assert.rejects(() => pending, /cancelled/);
		assert.strictEqual(seenSignal, controller.signal, 'streamResponse 第三参必须是 signal');
	});

	it('adapter 无 complete 时退化的流式路径同样收到 signal', async () => {
		const controller = new AbortController();
		let seenSignal: AbortSignal | undefined;
		const adapter: LLMAdapter = {
			name: 'test',
			buildRequest: (request) => request,
			streamResponse: (_request, _callbacks, signal) => {
				seenSignal = signal;
				signal?.addEventListener('abort', () => {
					_callbacks.onError?.(new Error('ClassMate request was cancelled.'));
				}, { once: true });
			},
		};
		const client = new AdapterGraphModelClient(adapter);
		const pending = client.complete(
			[{ role: 'user', content: 'answer' }],
			{ label: 'answer', signal: controller.signal }
		);
		setTimeout(() => controller.abort(), 10);
		await assert.rejects(() => pending, /cancelled/);
		assert.strictEqual(seenSignal, controller.signal);
	});
});

describe('FallbackGraphModelClient (7.8 备用 provider 切换)', () => {
	function client(result: string, failTimes = 0): {
		client: import('../graph/modelClient').GraphModelClient;
		calls: () => number;
	} {
		let calls = 0;
		return {
			client: {
				async complete() {
					calls++;
					if (calls <= failTimes) {
						throw new Error('primary down');
					}
					return { content: result };
				},
			},
			calls: () => calls,
		};
	}

	it('does not touch the fallback when the primary succeeds', async () => {
		const primary = client('ok');
		const fallback = client('fallback');
		const wrapped = new FallbackGraphModelClient({
			primary: primary.client,
			fallback: fallback.client,
		});
		const result = await wrapped.complete([{ role: 'user', content: 'q' }]);
		assert.strictEqual(result.content, 'ok');
		assert.strictEqual(primary.calls(), 1);
		assert.strictEqual(fallback.calls(), 0);
	});

	it('switches to the fallback once when the primary throws, and reports usage of it', async () => {
		const primary = client('never', 99);
		const fallback = client('rescued');
		const used: Array<{ label?: string; attempt: number }> = [];
		const wrapped = new FallbackGraphModelClient({
			primary: primary.client,
			fallback: fallback.client,
			onFallbackUsed: (info) => used.push(info),
		});
		const first = await wrapped.complete(
			[{ role: 'user', content: 'q' }],
			{ label: 'answer' }
		);
		assert.strictEqual(first.content, 'rescued');
		assert.strictEqual(used.length, 1);
		assert.strictEqual(used[0].label, 'answer');
		assert.strictEqual(used[0].attempt, 1);
	});

	it('stops switching after the configured budget is exhausted', async () => {
		const primary = client('never', 99);
		const fallback = client('rescued', 1);
		const wrapped = new FallbackGraphModelClient({
			primary: primary.client,
			fallback: fallback.client,
			maxFallbackCalls: 1,
		});
		// 第一次:主败→备用败,异常上抛(此时备用预算已用掉)。
		await assert.rejects(
			() => wrapped.complete([{ role: 'user', content: 'q' }]),
			/fallback down|primary down/
		);
		const before = fallback.calls();
		// 第二次:主败,但备用预算耗尽,直接上抛主错误,不再打备用。
		await assert.rejects(
			() => wrapped.complete([{ role: 'user', content: 'q2' }]),
			/primary down/
		);
		assert.strictEqual(fallback.calls(), before, '备用不再被调用');
	});
});
