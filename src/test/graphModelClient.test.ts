import * as assert from 'assert';
import { describe, it } from 'mocha';
import { AdapterGraphModelClient } from '../graph/modelClient';
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
});
