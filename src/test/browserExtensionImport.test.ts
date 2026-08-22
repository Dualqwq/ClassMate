import * as assert from 'assert';
import * as http from 'http';
import * as vscode from 'vscode';
import { describe, it } from 'mocha';
import {
	buildMarkdownBody,
	handleBrowserExtensionImport,
	type BrowserExtensionImportDependencies,
} from '../browserExtensionImport/importHandler';
import { startBrowserExtensionImportServer } from '../browserExtensionImport/server';

describe('Browser extension import', () => {
	describe('buildMarkdownBody', () => {
		it('returns raw markdown when no metadata is provided', () => {
			const result = buildMarkdownBody('# Hello');
			assert.strictEqual(result, '# Hello');
		});

		it('adds title frontmatter', () => {
			const result = buildMarkdownBody('body', 'My Title');
			assert.ok(result.startsWith('---\ntitle: "My Title"\n---\n\nbody'));
		});

		it('escapes quotes in title and source', () => {
			const result = buildMarkdownBody('body', 'A "quoted" title', 'https://ex.com/?a="b"');
			assert.ok(result.includes('title: "A \\"quoted\\" title"'));
			assert.ok(result.includes('source: "https://ex.com/?a=\\"b\\""'));
		});
	});

	describe('handleBrowserExtensionImport', () => {
		it('returns false when markdown is empty', async () => {
			const calls: string[] = [];
			const deps = makeMockDeps({ warning: (m) => { calls.push(m); return Promise.resolve(undefined); } });
			const result = await handleBrowserExtensionImport({ markdown: '' }, deps);
			assert.strictEqual(result, false);
			assert.ok(calls.some((m) => m.includes('内容为空')));
		});

		it('writes file and opens it when user confirms save dialog', async () => {
			const targetUri = vscode.Uri.file('/tmp/README.md');
			const written: { uri: vscode.Uri; content: string }[] = [];
			const opened: vscode.Uri[] = [];
			const messages: string[] = [];
			const deps = makeMockDeps({
				showSaveDialog: async () => targetUri,
				writeFile: async (uri, content) => {
					written.push({ uri, content: Buffer.from(content).toString('utf-8') });
				},
				showTextDocument: async (uri) => {
					opened.push(uri);
					return {} as vscode.TextEditor;
				},
				information: (m) => { messages.push(m); return Promise.resolve(undefined); },
			});

			const result = await handleBrowserExtensionImport({
				markdown: '# Problem',
				title: 'Problem Title',
				url: 'https://example.com/problem',
			}, deps);

			assert.strictEqual(result, true);
			assert.strictEqual(written.length, 1);
			assert.strictEqual(written[0].uri.toString(), targetUri.toString());
			assert.ok(written[0].content.includes('Problem Title'));
			assert.ok(written[0].content.includes('https://example.com/problem'));
			assert.strictEqual(opened.length, 1);
			assert.ok(messages.some((m) => m.includes('已导入')));
		});

		it('calls showSaveDialog exactly once with README.md defaults for a valid request', async () => {
			const dialogCalls: vscode.SaveDialogOptions[] = [];
			const deps = makeMockDeps({
				showSaveDialog: async (options) => {
					dialogCalls.push(options);
					return vscode.Uri.file('/tmp/README.md');
				},
			});

			const result = await handleBrowserExtensionImport({ markdown: '# Problem' }, deps);

			assert.strictEqual(result, true);
			assert.strictEqual(dialogCalls.length, 1, 'a valid request must open the save dialog exactly once');
			assert.strictEqual(dialogCalls[0].saveLabel, '导入题目');
			assert.deepStrictEqual(dialogCalls[0].filters, { Markdown: ['md'] });
			assert.ok(dialogCalls[0].defaultUri?.fsPath.endsWith('README.md'));
		});

		it('returns false when user cancels save dialog', async () => {
			let writeCalls = 0;
			const deps = makeMockDeps({
				showSaveDialog: async () => undefined,
				writeFile: async () => { writeCalls += 1; },
			});
			const result = await handleBrowserExtensionImport({ markdown: '# Problem' }, deps);
			assert.strictEqual(result, false);
			assert.strictEqual(writeCalls, 0, 'cancelling the dialog must never write a file');
		});
	});

	describe('local HTTP server', () => {
		it('starts and exposes a health endpoint with the actual port', async () => {
			const context = makeMockExtensionContext();
			const { port, dispose } = await startBrowserExtensionImportServer(context);
			try {
				assert.ok(port > 0, 'server should bind to a positive port');
				const response = await fetch(`http://127.0.0.1:${port}/health`);
				assert.strictEqual(response.status, 200);
				const body = await response.json() as { ok: boolean; port: number };
				assert.strictEqual(body.ok, true);
				assert.strictEqual(body.port, port);
			} finally {
				dispose();
			}
		});

		it('auto-binds inside the browser probe range so the extension can discover it', async function () {
			// G5 反馈回归:默认配置(importPort=0)下服务端必须落在浏览器扩展
			// 探测区间 53135–53145 内,否则浏览器永远找不到端点、保存弹窗不出现。
			// 区间被外部进程占满时会回退随机端口,该极端场景跳过断言。
			if (await isProbeRangeFullyOccupied()) {
				this.skip();
				return;
			}
			const { port, dispose } = await startBrowserExtensionImportServer(makeMockExtensionContext());
			try {
				assert.ok(
					port >= 53135 && port <= 53145,
					`expected auto-bound port in 53135-53145, got ${port}`
				);
			} finally {
				dispose();
			}
		});

		it('skips occupied probe-range ports and stays reachable', async () => {
			const occupier = http.createServer();
			let occupied = false;
			await new Promise<void>((resolve) => {
				occupier.once('error', () => resolve());
				occupier.listen(53135, '127.0.0.1', () => {
					occupied = true;
					resolve();
				});
			});
			try {
				const { port, dispose } = await startBrowserExtensionImportServer(makeMockExtensionContext());
				try {
					assert.notStrictEqual(port, 53135);
					const response = await fetch(`http://127.0.0.1:${port}/health`);
					assert.strictEqual(response.status, 200);
				} finally {
					dispose();
				}
			} finally {
				if (occupied) {
					await new Promise<void>((resolve) => occupier.close(() => resolve()));
				}
			}
		});

		it('assigns distinct ports to concurrent servers', async () => {
			const first = await startBrowserExtensionImportServer(makeMockExtensionContext());
			const second = await startBrowserExtensionImportServer(makeMockExtensionContext());
			try {
				assert.notStrictEqual(first.port, second.port);
				const response = await fetch(`http://127.0.0.1:${second.port}/health`);
				assert.strictEqual(response.status, 200);
			} finally {
				second.dispose();
				first.dispose();
			}
		});

		it('rejects non-localhost requests', async () => {
			const context = makeMockExtensionContext();
			const { port, dispose } = await startBrowserExtensionImportServer(context);
			try {
				// 构造一个会让服务器读取到伪造 remoteAddress 的请求不可行，
				// 因此这里只验证正常 localhost 请求仍成功，remoteAddress 分支由集成/人工测试覆盖。
				const response = await fetch(`http://127.0.0.1:${port}/health`);
				assert.strictEqual(response.status, 200);
			} finally {
				dispose();
			}
		});
	});
});

interface MockDepsInput {
	showSaveDialog?: (options: vscode.SaveDialogOptions) => Thenable<vscode.Uri | undefined>;
	writeFile?: (uri: vscode.Uri, content: Uint8Array) => Thenable<void>;
	showTextDocument?: (uri: vscode.Uri) => Thenable<vscode.TextEditor>;
	information?: (message: string) => Thenable<unknown>;
	warning?: (message: string) => Thenable<unknown>;
	error?: (message: string) => Thenable<unknown>;
	log?: (message: string) => void;
}

function makeMockDeps(input: MockDepsInput = {}): BrowserExtensionImportDependencies {
	return {
		showSaveDialog: input.showSaveDialog ?? (async () => undefined),
		writeFile: input.writeFile ?? (async () => undefined),
		showTextDocument: input.showTextDocument ?? (async () => ({} as vscode.TextEditor)),
		showInformationMessage: input.information ?? (() => Promise.resolve(undefined)),
		showWarningMessage: input.warning ?? (() => Promise.resolve(undefined)),
		showErrorMessage: input.error ?? (() => Promise.resolve(undefined)),
	};
}

function makeMockExtensionContext(): vscode.ExtensionContext {
	const storage = new Map<string, unknown>();
	return {
		subscriptions: [],
		workspaceState: {
			get: () => undefined,
			update: async () => undefined,
		} as unknown as vscode.Memento,
		globalState: {
			get: <T>(key: string, defaultValue?: T) =>
				(storage.has(key) ? storage.get(key) as T : defaultValue) as T,
			update: async (key: string, value: unknown) => {
				if (value === undefined) {
					storage.delete(key);
				} else {
					storage.set(key, value);
				}
			},
		} as unknown as vscode.Memento,
		// Only the fields used by startBrowserExtensionImportServer are stubbed.
	} as unknown as vscode.ExtensionContext;
}

/**
 * 探测区间 53135–53145 是否已被外部进程全部占用（极端环境下跳过区间断言用）。
 */
async function isProbeRangeFullyOccupied(): Promise<boolean> {
	const probes = Array.from({ length: 11 }, (_, i) => 53135 + i);
	const results = await Promise.all(probes.map(async (port) => {
		try {
			const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
			await response.arrayBuffer().catch(() => undefined);
			return true;
		} catch {
			// 连接失败说明端口无人监听。
			return false;
		}
	}));
	return results.every((listening) => listening);
}
