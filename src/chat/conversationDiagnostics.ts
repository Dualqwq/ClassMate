import { promises as fs } from 'fs';
import * as path from 'path';
import type { PersistedChatConversation } from './types';

export type ConversationDiagnosticEventType =
	| 'turn_started'
	| 'model_request'
	| 'model_response'
	| 'model_error'
	| 'graph_debug'
	| 'graph_node_completed'
	| 'graph_node_failed'
	| 'reference_extraction_completed'
	| 'reference_extraction_failed'
	| 'reference_link_opened'
	| 'turn_completed'
	| 'turn_failed'
	| 'turn_cancelled';

export interface ConversationDiagnosticEvent {
	schemaVersion: 1;
	sequence: number;
	timestamp: string;
	sessionId: string;
	workspaceId: string;
	type: ConversationDiagnosticEventType;
	conversationId?: string;
	requestId?: string;
	data: unknown;
}

export interface ConversationDiagnosticBundle {
	schemaVersion: 1;
	exportedAt: string;
	extensionVersion: string;
	sessionId: string;
	workspaceId: string;
	provider?: string;
	model?: string;
	workspaceFolders: string[];
	activeConversationId: string;
	conversations: PersistedChatConversation[];
	events: ConversationDiagnosticEvent[];
	notes: string[];
}

export interface ConversationDiagnosticExportInput {
	extensionVersion: string;
	provider?: string;
	model?: string;
	workspaceFolders: string[];
	activeConversationId: string;
	conversations: PersistedChatConversation[];
}

export interface ConversationDiagnosticRecordInput {
	type: ConversationDiagnosticEventType;
	conversationId?: string;
	requestId?: string;
	data: unknown;
}

const SECRET_KEYS = new Set([
	'apikey',
	'authorization',
	'proxyauthorization',
	'accesstoken',
	'refreshtoken',
	'secret',
	'password',
]);

function normalizedKey(value: string): string {
	return value.toLocaleLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Diagnostics intentionally keep prompts, answers and workspace text intact.
 * Only credential-shaped object properties are removed. Text that happens to
 * contain words such as `apiKey` is student content and must not be rewritten.
 */
export function sanitizeDiagnosticValue(value: unknown): unknown {
	const ancestors = new WeakSet<object>();
	const visit = (current: unknown): unknown => {
		if (
			current === null
			|| typeof current === 'string'
			|| typeof current === 'number'
			|| typeof current === 'boolean'
		) {
			return current;
		}
		if (typeof current === 'bigint') {
			return current.toString();
		}
		if (typeof current === 'undefined' || typeof current === 'function') {
			return undefined;
		}
		if (current instanceof Date) {
			return current.toISOString();
		}
		if (current instanceof Error) {
			return {
				name: current.name,
				message: current.message,
				stack: current.stack,
			};
		}
		if (typeof current !== 'object') {
			return String(current);
		}
		if (ancestors.has(current)) {
			return '[Circular]';
		}
		ancestors.add(current);
		if (Array.isArray(current)) {
			const output = current.map(visit);
			ancestors.delete(current);
			return output;
		}
		const output: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(current)) {
			if (SECRET_KEYS.has(normalizedKey(key))) {
				continue;
			}
			const sanitized = visit(item);
			if (sanitized !== undefined) {
				output[key] = sanitized;
			}
		}
		ancestors.delete(current);
		return output;
	};
	return visit(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseDiagnosticEvent(value: unknown): ConversationDiagnosticEvent {
	if (!isRecord(value)) {
		throw new Error('Diagnostic event must be an object.');
	}
	if (
		value.schemaVersion !== 1
		|| !Number.isSafeInteger(value.sequence)
		|| typeof value.timestamp !== 'string'
		|| typeof value.sessionId !== 'string'
		|| typeof value.workspaceId !== 'string'
		|| typeof value.type !== 'string'
		|| !('data' in value)
	) {
		throw new Error('Diagnostic event is missing required fields.');
	}
	return value as unknown as ConversationDiagnosticEvent;
}

export function parseConversationDiagnosticBundle(
	value: unknown
): ConversationDiagnosticBundle {
	if (!isRecord(value)) {
		throw new Error('Diagnostic bundle must be an object.');
	}
	if (
		value.schemaVersion !== 1
		|| typeof value.exportedAt !== 'string'
		|| typeof value.extensionVersion !== 'string'
		|| typeof value.sessionId !== 'string'
		|| typeof value.workspaceId !== 'string'
		|| !Array.isArray(value.workspaceFolders)
		|| typeof value.activeConversationId !== 'string'
		|| !Array.isArray(value.conversations)
		|| !Array.isArray(value.events)
		|| !Array.isArray(value.notes)
	) {
		throw new Error('Diagnostic bundle is missing required fields.');
	}
	return {
		...(value as unknown as ConversationDiagnosticBundle),
		events: value.events.map(parseDiagnosticEvent),
	};
}

export class ConversationDiagnosticRecorder {
	private _sequence = 0;
	private _writeQueue: Promise<void> = Promise.resolve();
	private _writeError: unknown;

	constructor(
		private readonly _journalPath: string,
		private readonly _identity: { sessionId: string; workspaceId: string }
	) {}

	public record(input: ConversationDiagnosticRecordInput): ConversationDiagnosticEvent {
		const event: ConversationDiagnosticEvent = {
			schemaVersion: 1,
			sequence: ++this._sequence,
			timestamp: new Date().toISOString(),
			sessionId: this._identity.sessionId,
			workspaceId: this._identity.workspaceId,
			type: input.type,
			conversationId: input.conversationId,
			requestId: input.requestId,
			data: sanitizeDiagnosticValue(input.data),
		};
		const line = `${JSON.stringify(event)}\n`;
		this._writeQueue = this._writeQueue
			.then(async () => {
				await fs.mkdir(path.dirname(this._journalPath), { recursive: true });
				await fs.appendFile(this._journalPath, line, 'utf8');
			})
			.catch((error) => {
				this._writeError ??= error;
			});
		return event;
	}

	public async flush(): Promise<void> {
		await this._writeQueue;
		if (this._writeError) {
			throw this._writeError;
		}
	}

	public async exportTo(
		outputPath: string,
		input: ConversationDiagnosticExportInput
	): Promise<ConversationDiagnosticBundle> {
		await this.flush();
		const journalDirectory = path.dirname(this._journalPath);
		const journalNames = await fs.readdir(journalDirectory).catch(
			(error: NodeJS.ErrnoException) => {
				if (error.code === 'ENOENT') {
					return [];
				}
				throw error;
			}
		);
		const journals = await Promise.all(
			journalNames
				.filter((name) => name.toLocaleLowerCase().endsWith('.jsonl'))
				.sort()
				.map((name) => fs.readFile(path.join(journalDirectory, name), 'utf8'))
		);
		const events = journals
			.flatMap((journal) => journal
				.split(/\r?\n/)
				.map((line) => line.trim())
				.filter(Boolean)
				.map((line) => parseDiagnosticEvent(JSON.parse(line))))
			.filter((event) => event.conversationId === input.activeConversationId)
			.sort((left, right) =>
				left.timestamp.localeCompare(right.timestamp)
				|| left.sessionId.localeCompare(right.sessionId)
				|| left.sequence - right.sequence
			);
		const sanitizedInput = sanitizeDiagnosticValue(input) as ConversationDiagnosticExportInput;
		// 导出范围 = 仅 active 会话:其他会话的聊天记录一并不出,
		// 避免一次导出带出整个工作区历史(含学生代码/对话隐私)。
		const activeConversation = sanitizedInput.conversations.filter(
			(conversation) => conversation.id === input.activeConversationId
		);
		const bundle: ConversationDiagnosticBundle = {
			schemaVersion: 1,
			exportedAt: new Date().toISOString(),
			extensionVersion: sanitizedInput.extensionVersion,
			sessionId: this._identity.sessionId,
			workspaceId: this._identity.workspaceId,
			provider: sanitizedInput.provider,
			model: sanitizedInput.model,
			workspaceFolders: sanitizedInput.workspaceFolders,
			activeConversationId: sanitizedInput.activeConversationId,
			conversations: activeConversation,
			events,
			notes: [
				'Only the active conversation and its graph events are included.',
				'Events are available only for turns recorded after the diagnostics feature was installed.',
				'This local file contains student prompts, answers and workspace source content.',
			],
		};
		const parsed = parseConversationDiagnosticBundle(bundle);
		await fs.mkdir(path.dirname(outputPath), { recursive: true });
		const temporaryPath = `${outputPath}.tmp-${process.pid}-${Date.now()}`;
		await fs.writeFile(temporaryPath, JSON.stringify(parsed, null, 2), 'utf8');
		await fs.rename(temporaryPath, outputPath);
		return parsed;
	}
}
