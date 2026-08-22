import * as assert from 'assert';
import { describe, it } from 'mocha';
import {
	buildLocalSettingsUrl,
	ensureLocalToken,
	openLocalSettingsPage,
	LOCAL_TOKEN_SECRET_KEY,
} from '../settings/localSettings';

/** 极简 vscode.ExtensionContext 替身:仅 secrets 为内存 Map。 */
function mockContext() {
	const secrets = new Map<string, string>();
	return {
		secrets: {
			get: async (key: string) => secrets.get(key),
			store: async (key: string, value: string) => {
				secrets.set(key, value);
			},
			delete: async (key: string) => {
				secrets.delete(key);
			},
		},
	};
}

describe('settings entry (ADD5 入口行为锁)', () => {
	it('openLocalSettingsPage opens the local page with the token via the opener', async () => {
		const context = mockContext();
		const token = await ensureLocalToken(context as never);
		const opened: string[] = [];

		await openLocalSettingsPage(
			context as never,
			'http://127.0.0.1:49152',
			(url) => {
				opened.push(url);
				return Promise.resolve(true);
			}
		);

		// 回归锚点(G5 复测):设置入口必须引导到带 token 的本地网页设置页,
		// 而不是任何原生输入框/内嵌弹窗等替代 UI。
		assert.deepStrictEqual(opened, [
			`http://127.0.0.1:49152?t=${encodeURIComponent(token)}`,
		]);
		assert.strictEqual(await context.secrets.get(LOCAL_TOKEN_SECRET_KEY), token);
	});

	it('buildLocalSettingsUrl keeps existing query and encodes the token', () => {
		assert.strictEqual(
			buildLocalSettingsUrl('http://127.0.0.1:8080', 'a b&c'),
			'http://127.0.0.1:8080?t=a%20b%26c'
		);
		assert.strictEqual(
			buildLocalSettingsUrl('http://127.0.0.1:8080/?src=panel', 't2'),
			'http://127.0.0.1:8080/?src=panel&t=t2'
		);
	});
});
