import * as assert from 'assert';
import { describe, it } from 'mocha';
import { DeepSeekAdapter } from '../llm/DeepSeekAdapter';
import { normalizeOpenAIUsage, OpenAIAdapter } from '../llm/OpenAIAdapter';

describe('OpenAIAdapter signal 取消传导(run17 取证回归)', () => {
	function installFakeOpenAI(calls: Array<Record<string, unknown>>): () => void {
		const resolved = require.resolve('openai');
		// openai v4 的 CJS 导出形态是 module.exports = Class(自挂 .default),
		// `require('openai')` 直接可构造,假模块必须复刻这个形态。
		const FakeOpenAI = class {
			public readonly chat = {
				completions: {
					create: async (body: Record<string, unknown>, opts?: Record<string, unknown>) => {
						calls.push({ ...body, __options: opts });
						if (body.stream) {
							return (async function* () {
								yield { choices: [{ delta: { content: 'ok' } }] };
							})();
						}
						return {
							choices: [{ message: { content: 'ok' } }],
							usage: { prompt_tokens: 1, completion_tokens: 1 },
						};
					},
				},
			};
			constructor(_config: unknown) { void _config; }
		};
		(FakeOpenAI as unknown as { default: unknown }).default = FakeOpenAI;
		const previous = require.cache[resolved];
		require.cache[resolved] = { exports: FakeOpenAI } as unknown as NodeJS.Module;
		return () => {
			if (previous) {
				require.cache[resolved] = previous;
			} else {
				delete require.cache[resolved];
			}
		};
	}

	it('非流式 complete 把 signal 作为 SDK create 的第二参传入,且不进请求体', async () => {
		const calls: Array<Record<string, unknown>> = [];
		const restore = installFakeOpenAI(calls);
		try {
			const adapter = new OpenAIAdapter({ apiKey: 'test', model: 'm' });
			const controller = new AbortController();
			const result = await adapter.complete({
				messages: [{ role: 'user', content: 'q' }],
				signal: controller.signal,
			});
			assert.strictEqual(result.content, 'ok');
			assert.strictEqual(calls.length, 1);
			assert.deepStrictEqual(calls[0].__options, { signal: controller.signal });
			assert.strictEqual(calls[0].signal, undefined, 'signal 不能序列化进请求体');
		} finally {
			restore();
		}
	});

	it('流式 streamResponse 把 signal 作为 SDK create 的第二参传入', async () => {
		const calls: Array<Record<string, unknown>> = [];
		const restore = installFakeOpenAI(calls);
		try {
			const adapter = new OpenAIAdapter({ apiKey: 'test', model: 'm' });
			const controller = new AbortController();
			await new Promise<void>((resolve) => {
				adapter.streamResponse(
					adapter.buildRequest({ messages: [{ role: 'user', content: 'q' }] }),
					{ onToken: () => undefined, onComplete: () => resolve() },
					controller.signal
				);
			});
			assert.strictEqual(calls.length, 1);
			assert.deepStrictEqual(calls[0].__options, { signal: controller.signal });
		} finally {
			restore();
		}
	});
});

describe('OpenAI-compatible cache usage', () => {
	it('requests usage in streaming responses', () => {
		const adapter = new OpenAIAdapter({ apiKey: 'test', model: 'test-model' });
		const body = adapter.buildRequest({
			messages: [{ role: 'user', content: 'hello' }],
		}) as Record<string, unknown>;
		assert.deepStrictEqual(body.stream_options, { include_usage: true });
	});

	it('enables JSON object mode only when requested', () => {
		const adapter = new OpenAIAdapter({ apiKey: 'test', model: 'test-model' });
		const jsonBody = adapter.buildRequest({
			messages: [{ role: 'user', content: 'return json' }],
			jsonMode: true,
		}) as Record<string, unknown>;
		const textBody = adapter.buildRequest({
			messages: [{ role: 'user', content: 'return text' }],
		}) as Record<string, unknown>;

		assert.deepStrictEqual(jsonBody.response_format, { type: 'json_object' });
		assert.strictEqual(textBody.response_format, undefined);
	});

	it('disables thinking for DeepSeek planning without leaking the parameter to OpenAI', () => {
		const deepSeek = new DeepSeekAdapter({ apiKey: 'test', model: 'deepseek-v4-flash' });
		const openAI = new OpenAIAdapter({ apiKey: 'test', model: 'gpt-test' });
		const request = {
			messages: [{ role: 'user' as const, content: 'plan' }],
			thinkingMode: 'disabled' as const,
		};

		assert.deepStrictEqual(
			(deepSeek.buildRequest(request) as Record<string, unknown>).thinking,
			{ type: 'disabled' }
		);
		assert.strictEqual(
			(openAI.buildRequest(request) as Record<string, unknown>).thinking,
			undefined
		);
	});

	it('encodes attached images as OpenAI-compatible image_url content', () => {
		const adapter = new OpenAIAdapter({ apiKey: 'test', model: 'vision-model' });
		const body = adapter.buildRequest({ messages: [{
			role: 'user',
			content: 'describe',
			images: [{ name: 'test.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,AAAA' }],
		}] }) as { messages: Array<{ content: unknown }> };
		assert.deepStrictEqual(body.messages[0].content, [
			{ type: 'text', text: 'describe' },
			{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
		]);
	});

	it('includes readable attachment contents in the user message', () => {
		const adapter = new OpenAIAdapter({ apiKey: 'test', model: 'test-model' });
		const body = adapter.buildRequest({ messages: [{
			role: 'user',
			content: 'review this file',
			attachments: [{ name: 'main.cpp', mimeType: 'text/plain', size: 12, content: 'int main(){}' }],
		}] }) as { messages: Array<{ content: string }> };
		assert.ok(body.messages[0].content.includes('Attached file: main.cpp'));
		assert.ok(body.messages[0].content.includes('int main(){}'));
	});

	it('reads DeepSeek cache counters', () => {
		assert.deepStrictEqual(normalizeOpenAIUsage({
			prompt_tokens: 100,
			completion_tokens: 20,
			total_tokens: 120,
			prompt_cache_hit_tokens: 80,
			prompt_cache_miss_tokens: 20,
		}), {
			inputTokens: 100,
			outputTokens: 20,
			totalTokens: 120,
			cacheHitTokens: 80,
			cacheMissTokens: 20,
		});
	});
});
