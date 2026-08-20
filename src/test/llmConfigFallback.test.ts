import * as assert from 'assert';
import { describe, it } from 'mocha';
import {
	getFallbackLLMConfig,
	saveFallbackLLMConfig,
	getFallbackApiKey,
} from '../config/llmConfig';

/** 极简 vscode.ExtensionContext 替身:globalState/secrets 均为内存 Map。 */
function mockContext() {
	const state = new Map<string, unknown>();
	const secrets = new Map<string, string>();
	return {
		globalState: {
			get: <T>(key: string) => state.get(key) as T | undefined,
			update: async (key: string, value: unknown) => {
				if (value === undefined) {
					state.delete(key);
				} else {
					state.set(key, value);
				}
			},
		},
		secrets: {
			get: async (key: string) => secrets.get(key),
			store: async (key: string, value: string) => {
				secrets.set(key, value);
			},
			delete: async (key: string) => {
				secrets.delete(key);
			},
		},
	} as unknown as Parameters<typeof saveFallbackLLMConfig>[0];
}

describe('fallback LLM config (7.8 显式备用 provider)', () => {
	it('returns undefined when nothing was configured (no implicit fallback)', async () => {
		const context = mockContext();
		assert.strictEqual(await getFallbackLLMConfig(context), undefined);
	});

	it('round-trips provider/model/url and keeps a stored key across an empty update', async () => {
		const context = mockContext();
		await saveFallbackLLMConfig(context, {
			provider: 'deepseek',
			model: 'deepseek-chat',
			apiKey: 'sk-fallback',
			apiUrl: 'https://example.internal/v1',
		});
		let config = await getFallbackLLMConfig(context);
		assert.strictEqual(config?.provider, 'deepseek');
		assert.strictEqual(config?.model, 'deepseek-chat');
		assert.strictEqual(config?.apiKeySet, true);
		assert.strictEqual(config?.apiUrl, 'https://example.internal/v1');
		assert.strictEqual(await getFallbackApiKey(context), 'sk-fallback');

		// 留空 key 表示保留已存 key(与主配置一致)。
		await saveFallbackLLMConfig(context, {
			provider: 'deepseek',
			model: 'deepseek-reasoner',
		});
		config = await getFallbackLLMConfig(context);
		assert.strictEqual(config?.model, 'deepseek-reasoner');
		assert.strictEqual(await getFallbackApiKey(context), 'sk-fallback');
	});

	it('clearing removes every stored field including the secret', async () => {
		const context = mockContext();
		await saveFallbackLLMConfig(context, {
			provider: 'openai',
			model: 'gpt-4.1',
			apiKey: 'sk-x',
		});
		await saveFallbackLLMConfig(context, null);
		assert.strictEqual(await getFallbackLLMConfig(context), undefined);
		assert.strictEqual(await getFallbackApiKey(context), undefined);
	});
});
