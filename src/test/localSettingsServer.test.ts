import * as assert from 'assert';
import * as http from 'http';
import { describe, it, afterEach } from 'mocha';
import {
	createLocalSettingsServer,
	LOCAL_TOKEN_SECRET_KEY,
	type LocalSettingsServer,
} from '../settings/localSettingsServer';
import { buildThemePayload } from '../settings/themePayload';
import { getThemeSettings } from '../settings/localSettings';

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
	} as unknown as Parameters<typeof createLocalSettingsServer>[0];
}

describe('local settings server (ADD5)', () => {
	const running: LocalSettingsServer[] = [];

	afterEach(async () => {
		await Promise.all(running.splice(0).map((server) => server.close()));
	});

	async function startServer(
		context = mockContext(),
		options: Parameters<typeof createLocalSettingsServer>[1] = {}
	) {
		const server = await createLocalSettingsServer(context, options);
		running.push(server);
		return { server, context };
	}

	async function getToken(context: ReturnType<typeof mockContext>): Promise<string> {
		const token = await context.secrets.get(LOCAL_TOKEN_SECRET_KEY);
		if (!token) {
			throw new Error('Server did not create a token.');
		}
		return token;
	}

	it('serves the settings page at /', async () => {
		const { server, context } = await startServer();
		const token = await getToken(context);
		const response = await fetch(`${server.url}/?t=${encodeURIComponent(token)}`);
		assert.strictEqual(response.status, 200);
		const html = await response.text();
		assert.ok(html.includes('ClassMate 设置'));
		assert.ok(html.includes(token));
	});

	it('settings page marks color inputs custom while the user edits them', async () => {
		const { server, context } = await startServer();
		const token = await getToken(context);
		const html = await (await fetch(`${server.url}/?t=${encodeURIComponent(token)}`)).text();
		// 回归锚点(G5 复测取证):此前没有任何 input 监听把 dataset.custom 置位,
		// 提交载荷恒为空串 → 服务端存/广播空主题 → 保存颜色完全无效。
		// 内嵌脚本是 HTML 字符串,行为无法在 server 单测里执行,只能锁存在监听。
		assert.ok(html.includes("addEventListener('input'"));
	});

	it('GET /api/config returns config without exposing the apiKey', async () => {
		const { server, context } = await startServer();
		const token = await getToken(context);
		const response = await fetch(`${server.url}/api/config`, {
			headers: { 'X-ClassMate-Token': token },
		});
		assert.strictEqual(response.status, 200);
		const config = await response.json() as Record<string, unknown>;
		assert.strictEqual(config.provider, 'claude');
		assert.strictEqual(typeof config.apiKeySet, 'boolean');
		assert.strictEqual(config.apiKey, undefined);
	});

	it('rejects API requests without token', async () => {
		const { server } = await startServer();
		const response = await fetch(`${server.url}/api/config`);
		assert.strictEqual(response.status, 401);
	});

	it('rejects API requests with wrong token', async () => {
		const { server } = await startServer();
		const response = await fetch(`${server.url}/api/config`, {
			headers: { 'X-ClassMate-Token': 'wrong-token' },
		});
		assert.strictEqual(response.status, 401);
	});

	it('rejects requests with non-localhost Host header', async () => {
		const { server, context } = await startServer();
		const token = await getToken(context);
		const url = new URL(`${server.url}/api/config`);
		const status = await new Promise<number>((resolve, reject) => {
			const req = http.request(
				{
					hostname: url.hostname,
					port: url.port,
					path: url.pathname,
					headers: {
						'X-ClassMate-Token': token,
						Host: 'evil.com',
					},
				},
				(res) => {
					resolve(res.statusCode ?? 0);
					res.resume();
				}
			);
			req.on('error', reject);
			req.end();
		});
		assert.strictEqual(status, 400);
	});

	it('never returns CORS headers', async () => {
		const { server, context } = await startServer();
		const token = await getToken(context);
		const response = await fetch(`${server.url}/api/config`, {
			method: 'OPTIONS',
			headers: { 'X-ClassMate-Token': token, Origin: 'https://example.com' },
		});
		assert.strictEqual(response.headers.get('access-control-allow-origin'), null);
		assert.strictEqual(response.headers.get('access-control-allow-private-network'), null);
	});

	it('POST /api/theme round-trips and broadcasts the saved theme', async () => {
		const { server, context } = await startServer();
		const token = await getToken(context);
		let broadcastedTheme: Record<string, unknown> | undefined;

		// Close the default server and recreate with a theme callback.
		const index = running.indexOf(server);
		if (index >= 0) {
			running.splice(index, 1);
		}
		await server.close();
		const serverWithCallback = await createLocalSettingsServer(context, {
			onThemeSaved: (theme) => {
				broadcastedTheme = theme as unknown as Record<string, unknown>;
			},
		});
		running.push(serverWithCallback);

		const theme = {
			userBubbleBackground: '#0e639c',
			assistantBubbleBackground: '#37373d',
			linkColor: '#4fc1ff',
			refFuncColor: '#dcdcaa',
		};

		const saveResponse = await fetch(`${serverWithCallback.url}/api/theme`, {
			method: 'POST',
			headers: { 'X-ClassMate-Token': token, 'Content-Type': 'application/json' },
			body: JSON.stringify(theme),
		});
		assert.strictEqual(saveResponse.status, 200);
		assert.deepStrictEqual(broadcastedTheme, theme);

		const getResponse = await fetch(`${serverWithCallback.url}/api/theme`, {
			headers: { 'X-ClassMate-Token': token },
		});
		assert.deepStrictEqual(await getResponse.json(), theme);
		assert.deepStrictEqual(await getThemeSettings(context), theme);
	});

	it('a page-built payload persists non-empty and broadcasts every changed field', async () => {
		// 行为级闭环(G5 复测):载荷不再手写,而是由设置页实际使用的
		// buildThemePayload 产出——模拟"用户改了两处颜色、其余保持重置态"。
		let broadcastedTheme: Record<string, unknown> | undefined;
		const { server, context } = await startServer(mockContext(), {
			onThemeSaved: (theme) => {
				broadcastedTheme = theme as unknown as Record<string, unknown>;
			},
		});
		const token = await getToken(context);

		const payload = buildThemePayload([
			{ key: 'userBubbleBackground', value: '#123456', custom: true },
			{ key: 'linkColor', value: '#ff8800', custom: true },
			{ key: 'refFuncColor', value: '#dcdcaa', custom: false },
			{ key: 'assistantBubbleBackground', value: '', custom: true },
		]);

		const saveResponse = await fetch(`${server.url}/api/theme`, {
			method: 'POST',
			headers: { 'X-ClassMate-Token': token, 'Content-Type': 'application/json' },
			body: JSON.stringify(payload),
		});
		assert.strictEqual(saveResponse.status, 200);
		// 广播载荷必须非空且恰好包含用户真正改过的字段(重置/未触碰的缺席)。
		assert.deepStrictEqual(broadcastedTheme, {
			userBubbleBackground: '#123456',
			linkColor: '#ff8800',
		});

		// GET 回读(= 重开面板 requestTheme 的读取路径)与持久化一致。
		const getResponse = await fetch(`${server.url}/api/theme`, {
			headers: { 'X-ClassMate-Token': token },
		});
		assert.deepStrictEqual(await getResponse.json(), broadcastedTheme);
		assert.deepStrictEqual(await getThemeSettings(context), broadcastedTheme);
	});

	it('POST /api/config persists provider/model/url and keeps key when omitted', async () => {
		const { server, context } = await startServer();
		const token = await getToken(context);

		const saveResponse = await fetch(`${server.url}/api/config`, {
			method: 'POST',
			headers: { 'X-ClassMate-Token': token, 'Content-Type': 'application/json' },
			body: JSON.stringify({
				provider: 'deepseek',
				model: 'deepseek-chat',
				apiUrl: 'https://api.example.com/v1',
			}),
		});
		assert.strictEqual(saveResponse.status, 200);

		const getResponse = await fetch(`${server.url}/api/config`, {
			headers: { 'X-ClassMate-Token': token },
		});
		const config = await getResponse.json() as Record<string, unknown>;
		assert.strictEqual(config.provider, 'deepseek');
		assert.strictEqual(config.model, 'deepseek-chat');
		assert.strictEqual(config.apiUrl, 'https://api.example.com/v1');
		assert.strictEqual(config.apiKeySet, false);
	});

	it('POST /api/config notifies onConfigSaved with persisted config and no key material', async () => {
		let savedConfig: Record<string, unknown> | undefined;
		const { server, context } = await startServer(mockContext(), {
			onConfigSaved: (config) => {
				savedConfig = config as unknown as Record<string, unknown>;
			},
		});
		const token = await getToken(context);

		const saveResponse = await fetch(`${server.url}/api/config`, {
			method: 'POST',
			headers: { 'X-ClassMate-Token': token, 'Content-Type': 'application/json' },
			body: JSON.stringify({ provider: 'openai', model: 'gpt-4.1', apiKey: 'sk-secret' }),
		});
		assert.strictEqual(saveResponse.status, 200);
		assert.ok(savedConfig);
		assert.strictEqual(savedConfig.provider, 'openai');
		assert.strictEqual(savedConfig.model, 'gpt-4.1');
		assert.strictEqual(savedConfig.apiKeySet, true);
		assert.strictEqual(savedConfig.apiKey, undefined);
	});

	it('POST /api/config does not notify onConfigSaved when the body is invalid', async () => {
		let notified = 0;
		const { server, context } = await startServer(mockContext(), {
			onConfigSaved: () => {
				notified += 1;
			},
		});
		const token = await getToken(context);

		const response = await fetch(`${server.url}/api/config`, {
			method: 'POST',
			headers: { 'X-ClassMate-Token': token, 'Content-Type': 'application/json' },
			body: JSON.stringify({ provider: 'nope' }),
		});
		assert.strictEqual(response.status, 400);
		assert.strictEqual(notified, 0);
	});

	it('POST /api/token/rotate invalidates the old token', async () => {
		const { server, context } = await startServer();
		const oldToken = await getToken(context);

		const rotateResponse = await fetch(`${server.url}/api/token/rotate`, {
			method: 'POST',
			headers: { 'X-ClassMate-Token': oldToken },
		});
		assert.strictEqual(rotateResponse.status, 200);
		const { token: newToken } = await rotateResponse.json() as { token: string };
		assert.notStrictEqual(newToken, oldToken);

		const oldResponse = await fetch(`${server.url}/api/config`, {
			headers: { 'X-ClassMate-Token': oldToken },
		});
		assert.strictEqual(oldResponse.status, 401);

		const newResponse = await fetch(`${server.url}/api/config`, {
			headers: { 'X-ClassMate-Token': newToken },
		});
		assert.strictEqual(newResponse.status, 200);
	});
});
