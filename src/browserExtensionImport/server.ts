import * as http from 'http';
import * as vscode from 'vscode';
import type { BrowserExtensionHealthResponse, BrowserExtensionImportRequest } from './types';
import { handleBrowserExtensionImport } from './importHandler';
import { browserImportLog } from './log';

const SERVER_HOST = '127.0.0.1';
const DEFAULT_PORT = 0;
const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MiB
// 浏览器扩展 background.js resolveListeningPort 默认探测的端口区间。
// 服务端默认必须落在该区间内,浏览器扩展才能自动发现端点;
// 否则随机端口永远探测不到,保存对话框不会弹出(G5 人审反馈的根因)。
const PROBE_RANGE_START = 53135;
const PROBE_RANGE_END = 53145;

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
		browserImportLog(`request ${req.method} ${req.url} from ${getRemoteAddress(req)}`);
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
			handleImportPost(req, res).catch((error: unknown) => {
				browserImportLog(`unhandled import error: ${error instanceof Error ? error.message : String(error)}`);
			});
			return;
		}

		res.writeHead(404, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Not found' }));
	});

	const strategy = await bindServerPort(server, configuredPort);

	const address = server.address();
	if (!address || typeof address === 'string') {
		throw new Error('Failed to determine server port');
	}
	const port = address.port;
	browserImportLog(`import server listening on ${SERVER_HOST}:${port} (${strategy})`);
	await context.globalState.update('classmate.browserExtension.importPort', port);

	server.on('error', (error: Error) => {
		browserImportLog(`server error: ${error.message}`);
	});

	const dispose = () => {
		browserImportLog(`import server on port ${port} disposed`);
		server.close();
		void context.globalState.update('classmate.browserExtension.importPort', undefined);
	};
	return { port, dispose };
}

/**
 * 绑定服务端口并返回绑定策略描述。
 * 显式配置 > 0 时直接使用；默认（0）先在浏览器扩展探测区间 53135–53145 内
 * 依次尝试第一个空闲端口（保证自动发现），区间全部被占才回退随机端口。
 */
async function bindServerPort(server: http.Server, configuredPort: number): Promise<string> {
	if (configuredPort > 0) {
		await listenOnce(server, configuredPort);
		return `configured port ${configuredPort}`;
	}
	for (let port = PROBE_RANGE_START; port <= PROBE_RANGE_END; port++) {
		try {
			await listenOnce(server, port);
			return `probe-range port ${port}`;
		} catch (error) {
			if (!isAddrInUse(error)) {
				throw error;
			}
			browserImportLog(`probe port ${port} occupied, trying next`);
		}
	}
	await listenOnce(server, DEFAULT_PORT);
	browserImportLog(
		`warning: probe range ${PROBE_RANGE_START}-${PROBE_RANGE_END} fully occupied, ` +
		'fell back to a random port; the browser extension cannot auto-discover it. ' +
		'Free a port or set classmate.browserExtension.importPort explicitly.'
	);
	return 'random fallback port';
}

function listenOnce(server: http.Server, port: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const onListening = () => {
			cleanup();
			resolve();
		};
		const onError = (error: Error) => {
			cleanup();
			reject(error);
		};
		const cleanup = () => {
			server.removeListener('listening', onListening);
			server.removeListener('error', onError);
		};
		server.once('listening', onListening);
		server.once('error', onError);
		server.listen(port, SERVER_HOST);
	});
}

function isAddrInUse(error: unknown): boolean {
	return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'EADDRINUSE';
}

function getRemoteAddress(req: http.IncomingMessage): string {
	// socket.remoteAddress 在 Node.js http 中始终可用。
	return req.socket.remoteAddress ?? '';
}

async function handleImportPost(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
	const contentType = req.headers['content-type'] ?? '';
	if (!contentType.includes('application/json')) {
		browserImportLog(`rejected: unsupported content-type "${contentType}"`);
		res.writeHead(415, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Unsupported media type. Use application/json.' }));
		return;
	}

	const chunks: Buffer[] = [];
	let received = 0;
	req.on('data', (chunk: Buffer) => {
		received += chunk.length;
		if (received > MAX_BODY_BYTES) {
			browserImportLog(`rejected: payload too large (> ${MAX_BODY_BYTES} bytes)`);
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
			browserImportLog(`rejected: invalid JSON (${raw.length} bytes)`);
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Invalid JSON' }));
			return;
		}

		if (!isImportRequest(body)) {
			browserImportLog('rejected: missing markdown field');
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Missing markdown field' }));
			return;
		}

		const ok = await handleBrowserExtensionImport(body);
		browserImportLog(`import request handled: ok=${ok}`);
		if (ok) {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ ok: true }));
		} else {
			res.writeHead(409, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ ok: false, error: 'User cancelled or save failed' }));
		}
	});

	req.on('error', (error: Error) => {
		browserImportLog(`request stream error: ${error.message}`);
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
