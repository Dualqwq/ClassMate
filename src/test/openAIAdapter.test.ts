import * as assert from 'assert';
import { describe, it } from 'mocha';
import { normalizeOpenAIUsage, OpenAIAdapter } from '../llm/OpenAIAdapter';

describe('OpenAI-compatible cache usage', () => {
	it('requests usage in streaming responses', () => {
		const adapter = new OpenAIAdapter({ apiKey: 'test', model: 'test-model' });
		const body = adapter.buildRequest({
			messages: [{ role: 'user', content: 'hello' }],
		}) as Record<string, unknown>;
		assert.deepStrictEqual(body.stream_options, { include_usage: true });
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
