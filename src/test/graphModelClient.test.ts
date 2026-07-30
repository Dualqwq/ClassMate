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
});
