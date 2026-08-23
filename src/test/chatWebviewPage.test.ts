import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import * as vm from 'vm';
import { describe, it } from 'mocha';
import { getChatWebviewHtml } from '../ui/getChatWebviewHtml';

// G5 第七轮:主题应用已从 React 组件下沉到 chat webview 页面原生层
// (getChatWebviewHtml 注入的内联 nonce 脚本,bundle 加载前即监听)。
// 本文件用 Node vm 行为级执行该内联脚本:宿主投递 themeUpdate 时,
// 页面必须立即写入 CSS 变量并回发带来源表面的 ack——React 是否存活不再影响着色。

interface HostLike {
	asWebviewUri(uri: vscode.Uri): vscode.Uri;
	cspSource: string;
}

function extractInlineScripts(html: string): string[] {
	const scripts: string[] = [];
	const pattern = /<script nonce="[A-Za-z0-9]+">([\s\S]*?)<\/script>/g;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(html)) !== null) {
		scripts.push(match[1]);
	}
	return scripts;
}

describe('chat webview native theme layer (行为级执行)', () => {
	it('applies themeUpdate to CSS variables and acks with the source surface', async () => {
		const extensionUri = vscode.Uri.file(path.join(os.tmpdir(), 'classmate-fake-ext'));
		const html = getChatWebviewHtml(
			{
				asWebviewUri: (uri: vscode.Uri) => uri,
				cspSource: 'vscode-webview://test',
			} as unknown as HostLike & vscode.Webview,
			extensionUri,
			undefined,
			'panel'
		);

		const applied = new Map<string, string>();
		const listeners: Array<(event: { data: unknown }) => void> = [];
		const directAcks: unknown[] = [];
		const root = {
			style: {
				setProperty: (name: string, value: string) => {
					if (value) {
						applied.set(name, value);
					} else {
						applied.delete(name);
					}
					// 浏览器语义:setProperty 后 computed 立即可读。
					computed.set(name, value);
				},
			},
		};
		const computed = new Map<string, string>();
		const sandbox: Record<string, unknown> = {
			window: {},
			document: { documentElement: root },
		};
		(sandbox.window as Record<string, unknown>).addEventListener = (
			_type: string,
			listener: (event: { data: unknown }) => void
		) => {
			listeners.push(listener);
		};
		(sandbox.window as Record<string, unknown>).getComputedStyle = () => ({
			getPropertyValue: (name: string) => computed.get(name) ?? '',
		});
		sandbox.document = { documentElement: root };
		(sandbox.window as Record<string, unknown>).document = sandbox.document;

		const context = vm.createContext(sandbox);
		for (const script of extractInlineScripts(html)) {
			vm.runInContext(script, context);
		}
		assert.ok(listeners.length > 0, 'native theme listener was not registered');

		// 宿主投递:用户气泡橙 + 链接色。
		for (const listener of listeners) {
			listener({
				data: {
					type: 'themeUpdate',
					theme: { userBubbleBackground: '#ff8800', linkColor: '#0066cc' },
				},
			});
		}

		assert.strictEqual(applied.get('--classmate-user-bubble-bg'), '#ff8800');
		assert.strictEqual(applied.get('--classmate-link-color'), '#0066cc');

		// bundle 尚未加载:ack 进入积压队列,且标注来源表面(panel)。
		const pending = (sandbox.window as { __classmatePendingAcks?: Array<Record<string, unknown>> })
			.__classmatePendingAcks;
		assert.ok(pending && pending.length === 1, 'native layer did not queue an ack');
		assert.strictEqual(pending[0].surface, 'panel');
		assert.strictEqual(pending[0].variableCount, 2);
		assert.strictEqual(pending[0].sampleVariable, '--classmate-user-bubble-bg');
		assert.strictEqual(pending[0].sampleValue, '#ff8800');

		// bundle 加载后桥就绪:后续 ack 直达宿主,且空主题清空全部变量。
		(sandbox.window as { __classmatePostMessage?: (m: unknown) => void }).__classmatePostMessage =
			(message: unknown) => {
				directAcks.push(message);
			};
		for (const listener of listeners) {
			listener({ data: { type: 'themeUpdate', theme: {} } });
		}
		assert.strictEqual(applied.size, 0, 'empty theme must clear every variable');
		assert.ok(directAcks.length === 1);
		assert.strictEqual((directAcks[0] as { variableCount: number }).variableCount, 0);
	});

	it('keeps the injected page free of external script sources inside inline blocks', () => {
		const extensionUri = vscode.Uri.file(path.join(os.tmpdir(), 'classmate-fake-ext'));
		const html = getChatWebviewHtml(
			{
				asWebviewUri: (uri: vscode.Uri) => uri,
				cspSource: 'vscode-webview://test',
			} as unknown as HostLike & vscode.Webview,
			extensionUri,
			undefined,
			'view'
		);
		// CSP 为 nonce 制:任何不带 nonce 的 <script> 都会被浏览器拒绝。
		assert.doesNotMatch(html, /<script>(?![\s\S]*nonce)/);
	});
});
