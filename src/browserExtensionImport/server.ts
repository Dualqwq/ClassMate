import * as http from 'http';
import * as vscode from 'vscode';
import type { BrowserExtensionHealthResponse, BrowserExtensionImportRequest } from './types';
import { handleBrowserExtensionImport } from './importHandler';

const SERVER_HOST = '127.0.0.1';
const DEFAULT_PORT = 0;
const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MiB

/**
 * 启动本地 HTTP 端点，仅监听 127.0.0.1，供 ClassMate 浏览器扩展导入题目。
 * 返回的端口号会写入全局状态，方便扩展 UI 展示或调试。
 */
export async function startBrowserExtensionImportServer(
	context: vscode.ExtensionContext
): Promise<{ port: number; dispose: () => void }> {
	const config = vscode.workspace.getConfiguration('classmate.browserExtension');
	const configuredPort = config.get<number>('importPort', DEFAULT_PORT);

	const server = http.createServer((req, res) => {
		// 仅允许本地回环访问，防止外部网络请求。
		const remoteAddress = getRemoteAddress(req);
		if (remoteAddress !== '127.0.0.1' && remoteAddress !== '::1' && remoteAddress !== '::ffff:127.0.0.1') {
			res.writeHead(403, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Forbidden: local loopback only' }));
			return;
		}

		// 允许浏览器扩展跨源调用；chrome-extension:// 协议没有固定 origin，
		// 因此用 * 配合不依赖 cookie 的简单请求语义。
		res.setHeader('Access-Control-Allow-Origin', '*');
		res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
		res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

		if (req.method === 'OPTIONS') {
			res.writeHead(204);
			res.end();
			return;
		}

		if (req.method === 'GET' && req.url === '/health') {
			const health: BrowserExtensionHealthResponse = {
				ok: true,
				port: (server.address() as import('net').AddressInfo).port,
			};
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify(health));
			return;
		}

		if (req.method === 'POST' && req.url === '/import') {
			void handleImportPost(req, res);
			return;
		}

		res.writeHead(404, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Not found' }));
	});

	return new Promise((resolve, reject) => {
		server.listen(configuredPort, SERVER_HOST, async () => {
			const address = server.address();
			if (!address || typeof address === 'string') {
				reject(new Error('Failed to determine server port'));
				return;
			}
			const port = address.port;
			await context.globalState.update('classmate.browserExtension.importPort', port);

			const dispose = () => {
				server.close();
				void context.globalState.update('classmate.browserExtension.importPort', undefined);
			};
			resolve({ port, dispose });
		});

		server.on('error', (error) => {
			reject(error);
		});
	});
}

function getRemoteAddress(req: http.IncomingMessage): string {
	// socket.remoteAddress 在 Node.js http 中始终可用。
	return req.socket.remoteAddress ?? '';
}

async function handleImportPost(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
	const contentType = req.headers['content-type'] ?? '';
	if (!contentType.includes('application/json')) {
		res.writeHead(415, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Unsupported media type. Use application/json.' }));
		return;
	}

	const chunks: Buffer[] = [];
	let received = 0;
	req.on('data', (chunk: Buffer) => {
		received += chunk.length;
		if (received > MAX_BODY_BYTES) {
			req.destroy();
			res.writeHead(413, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Payload too large' }));
			return;
		}
		chunks.push(chunk);
	});

	req.on('end', async () => {
		const raw = Buffer.concat(chunks).toString('utf-8');
		let body: unknown;
		try {
			body = JSON.parse(raw) as unknown;
		} catch {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Invalid JSON' }));
			return;
		}

		if (!isImportRequest(body)) {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Missing markdown field' }));
			return;
		}

		const ok = await handleBrowserExtensionImport(body);
		if (ok) {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ ok: true }));
		} else {
			res.writeHead(409, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ ok: false, error: 'User cancelled or save failed' }));
		}
	});

	req.on('error', () => {
		if (!res.writableEnded) {
			res.writeHead(500, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Internal server error' }));
		}
	});
}

function isImportRequest(value: unknown): value is BrowserExtensionImportRequest {
	return (
		value !== null &&
		typeof value === 'object' &&
		'markdown' in value &&
		typeof (value as BrowserExtensionImportRequest).markdown === 'string'
	);
}
