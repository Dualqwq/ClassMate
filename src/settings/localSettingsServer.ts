import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import * as vscode from 'vscode';
import type { ClassMateTheme, LLMConfig, LLMProvider } from '../chat/types';
import {
	getLLMConfig,
	saveLLMConfig,
	getFallbackLLMConfig,
	saveFallbackLLMConfig,
	type FallbackLLMConfigInput,
} from '../config/llmConfig';
import {
	ensureLocalToken,
	rotateLocalToken,
	getThemeSettings,
	saveThemeSettings,
	buildLocalSettingsUrl,
	LOCAL_TOKEN_SECRET_KEY,
} from './localSettings';
import { renderSettingsPageHtml } from './settingsPageHtml';

const DEFAULT_HOST = '127.0.0.1';
const MAX_REQUEST_BYTES = 256 * 1024;

export interface LocalSettingsServer {
	url: string;
	close(): Promise<void>;
}

export interface CreateLocalSettingsServerOptions {
	host?: string;
	port?: number;
	onThemeSaved?: (theme: ClassMateTheme) => void;
	/** 模型配置保存成功后回调(配置只含 apiKeySet 布尔,永不含 key 本体),供运行中 host 即时刷新缓存。 */
	onConfigSaved?: (config: LLMConfig) => void;
}

interface RequestContext {
	token: string;
	port: number;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
	response.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'cache-control': 'no-store',
	});
	response.end(JSON.stringify(value));
}

function sendText(
	response: ServerResponse,
	status: number,
	contentType: string,
	value: string
): void {
	response.writeHead(status, {
		'content-type': contentType,
		'cache-control': 'no-store',
		'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'",
	});
	response.end(value);
}

function sendError(response: ServerResponse, status: number, message: string): void {
	sendJson(response, status, { error: message });
}

function isAllowedHost(hostHeader: string | undefined, port: number): boolean {
	if (!hostHeader) {
		return false;
	}
	// Strip any userinfo or trailing whitespace.
	const host = hostHeader.split(':')[0]?.trim();
	if (host !== '127.0.0.1' && host !== 'localhost') {
		return false;
	}
	// Port may be absent for some clients; if present it must match.
	const parts = hostHeader.split(':');
	if (parts.length > 1) {
		const headerPort = parseInt(parts[parts.length - 1], 10);
		if (!Number.isNaN(headerPort) && headerPort !== port) {
			return false;
		}
	}
	return true;
}

function getRequestToken(request: IncomingMessage): string | undefined {
	const header = request.headers['x-classmate-token'];
	if (typeof header === 'string') {
		return header;
	}
	if (Array.isArray(header)) {
		return header[0];
	}
	return undefined;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		total += buffer.byteLength;
		if (total > MAX_REQUEST_BYTES) {
			throw new Error('Request body is too large.');
		}
		chunks.push(buffer);
	}
	return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function isString(value: unknown): value is string {
	return typeof value === 'string';
}

function isOptionalString(value: unknown): value is string | undefined {
	return value === undefined || typeof value === 'string';
}

function parseConfigBody(value: unknown): {
	provider: LLMProvider;
	model: string;
	apiUrl?: string;
	apiKey?: string;
	fallback: FallbackLLMConfigInput | null;
} {
	if (value === null || typeof value !== 'object') {
		throw new Error('Config must be an object.');
	}
	const body = value as Record<string, unknown>;
	if (!isString(body.provider) || !['claude', 'openai', 'deepseek'].includes(body.provider)) {
		throw new Error('Invalid provider.');
	}
	if (!isString(body.model) || !body.model.trim()) {
		throw new Error('Model is required.');
	}
	let fallback: FallbackLLMConfigInput | null = null;
	if (body.fallback !== null && body.fallback !== undefined) {
		if (typeof body.fallback !== 'object') {
			throw new Error('Fallback must be an object or null.');
		}
		const fb = body.fallback as Record<string, unknown>;
		if (!isString(fb.provider) || !['claude', 'openai', 'deepseek'].includes(fb.provider)) {
			throw new Error('Invalid fallback provider.');
		}
		if (!isString(fb.model) || !fb.model.trim()) {
			throw new Error('Fallback model is required.');
		}
		fallback = {
			provider: fb.provider as LLMProvider,
			model: fb.model.trim(),
			apiUrl: isOptionalString(fb.apiUrl) ? fb.apiUrl?.trim() || undefined : undefined,
			apiKey: isOptionalString(fb.apiKey) ? fb.apiKey?.trim() || undefined : undefined,
		};
	}
	return {
		provider: body.provider as LLMProvider,
		model: body.model.trim(),
		apiUrl: isOptionalString(body.apiUrl) ? body.apiUrl?.trim() || undefined : undefined,
		apiKey: isOptionalString(body.apiKey) ? body.apiKey?.trim() || undefined : undefined,
		fallback,
	};
}

function parseThemeBody(value: unknown): ClassMateTheme {
	if (value === null || typeof value !== 'object') {
		throw new Error('Theme must be an object.');
	}
	const body = value as Record<string, unknown>;
	const theme: ClassMateTheme = {};
	const keys: (keyof ClassMateTheme)[] = [
		'userBubbleBackground',
		'userBubbleForeground',
		'assistantBubbleBackground',
		'assistantBubbleForeground',
		'linkColor',
		'refFuncColor',
		'refTypeColor',
		'refVarColor',
		'refMacroColor',
		'refStdColor',
		'refOtherColor',
	];
	for (const key of keys) {
		const v = body[key];
		if (v === undefined || v === '' || v === null) {
			continue;
		}
		if (typeof v !== 'string') {
			throw new Error(`Theme field ${key} must be a string.`);
		}
		// Accept any non-empty string; color inputs send #rrggbb.
		if (v.trim()) {
			theme[key] = v.trim();
		}
	}
	return theme;
}

export async function createLocalSettingsServer(
	context: vscode.ExtensionContext,
	options: CreateLocalSettingsServerOptions = {}
): Promise<LocalSettingsServer> {
	const host = options.host ?? DEFAULT_HOST;
	const token = await ensureLocalToken(context);
	let currentToken = token;

	const server = createServer(async (request, response) => {
		try {
			const address = server.address();
			const port = address && typeof address === 'object' ? address.port : 0;
			const requestUrl = new URL(request.url ?? '/', `http://${host}:${port}`);

			if (request.method === 'GET' && requestUrl.pathname === '/') {
				const config = await getLLMConfig(context);
				const theme = await getThemeSettings(context);
				const html = renderSettingsPageHtml({ token: currentToken, port, config, theme });
				sendText(response, 200, 'text/html; charset=utf-8', html);
				return;
			}

			// All API endpoints require Host whitelist and token.
			if (!isAllowedHost(request.headers.host, port)) {
				sendError(response, 400, 'Invalid Host header.');
				return;
			}
			const requestToken = getRequestToken(request);
			if (!requestToken || requestToken !== currentToken) {
				sendError(response, 401, 'Missing or invalid token.');
				return;
			}

			const ctx: RequestContext = { token: currentToken, port };

			if (request.method === 'GET' && requestUrl.pathname === '/api/config') {
				const config = await getLLMConfig(context);
				sendJson(response, 200, config);
				return;
			}

			if (request.method === 'POST' && requestUrl.pathname === '/api/config') {
				const body = parseConfigBody(await readJsonBody(request));
				await saveLLMConfig(context, body.provider, body.model, body.apiKey, body.apiUrl);
				await saveFallbackLLMConfig(context, body.fallback);
				const saved = await getLLMConfig(context);
				options.onConfigSaved?.(saved);
				sendJson(response, 200, saved);
				return;
			}

			if (request.method === 'GET' && requestUrl.pathname === '/api/theme') {
				sendJson(response, 200, await getThemeSettings(context));
				return;
			}

			if (request.method === 'POST' && requestUrl.pathname === '/api/theme') {
				const theme = parseThemeBody(await readJsonBody(request));
				await saveThemeSettings(context, theme);
				options.onThemeSaved?.(theme);
				sendJson(response, 200, theme);
				return;
			}

			if (request.method === 'POST' && requestUrl.pathname === '/api/token/rotate') {
				currentToken = await rotateLocalToken(context);
				sendJson(response, 200, { token: currentToken });
				return;
			}

			sendError(response, 404, 'Not found.');
		} catch (error) {
			sendError(response, 400, error instanceof Error ? error.message : String(error));
		}
	});

	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(options.port ?? 0, host, () => {
			server.off('error', reject);
			resolve();
		});
	});

	const address = server.address();
	if (!address || typeof address === 'string') {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		throw new Error('Local settings server did not provide a TCP address.');
	}

	return {
		url: `http://${host}:${address.port}`,
		close: () => new Promise<void>((resolve, reject) => {
			server.close((error) => error ? reject(error) : resolve());
		}),
	};
}

export { buildLocalSettingsUrl, LOCAL_TOKEN_SECRET_KEY, getThemeSettings, saveThemeSettings };
