import * as path from 'path';
import { mkdir, readFile, writeFile } from 'fs/promises';
import type { PersistedChatData } from './types';
import { hashStorageKey } from '../storage/runHistoryStore';

export const CHAT_SESSIONS_DIR = 'chat-sessions';
const SINGLE_FILE_WORKSPACE = 'single-file';
const CHAT_SESSION_FILE = 'conversations.json';

/** 供迁移使用的最小 workspaceState 契约,便于单测用假对象驱动。 */
export interface ChatSessionMemento {
	get<T>(key: string): T | undefined;
	update(key: string, value?: unknown): Thenable<void>;
}

/**
 * ADD3 会话持久化原语:把聊天会话数据从 `workspaceState` 迁到
 * `globalStorageUri` 基座下的逐工作区目录(hash 输入 = 工作区 Uri),
 * 与 `runHistoryStore` 的存储布局保持一致。
 *
 * 布局:<globalStorage>/chat-sessions/<hash(工作区 Uri)>/conversations.json
 */
export class ChatSessionStorage {
	private readonly _workspaceDir: string;

	constructor(globalStorageDir: string, workspaceUri: string | undefined) {
		const workspaceKey = workspaceUri ?? SINGLE_FILE_WORKSPACE;
		this._workspaceDir = path.join(
			globalStorageDir,
			CHAT_SESSIONS_DIR,
			hashStorageKey(workspaceKey)
		);
	}

	public get workspaceDir(): string {
		return this._workspaceDir;
	}

	private _filePath(): string {
		return path.join(this._workspaceDir, CHAT_SESSION_FILE);
	}

	/** 读取已持久化的会话数据;文件不存在或损坏时返回 undefined。 */
	public async load(): Promise<PersistedChatData | undefined> {
		try {
			const text = await readFile(this._filePath(), 'utf8');
			const parsed = JSON.parse(text) as unknown;
			if (this._isValidPersistedData(parsed)) {
				return parsed;
			}
		} catch {
			// 文件不存在或 JSON 损坏:按无数据继续,不阻塞扩展启动。
		}
		return undefined;
	}

	/** 全量写入会话数据;目录不存在时自动创建。 */
	public async save(data: PersistedChatData): Promise<void> {
		await mkdir(this._workspaceDir, { recursive: true });
		await writeFile(this._filePath(), JSON.stringify(data), 'utf8');
	}

	/**
	 * 把旧 `workspaceState` 中按 `classmate.chatConversations.<workspaceId>`
	 * 存储的会话数据迁移到 StorageUri 新位置,然后删除旧 key。
	 *
	 * - 若旧 key 不存在,返回 false。
	 * - 若新存储已存在,保留新数据(不覆盖),也不删除旧 key,防止丢数据。
	 * - 迁移成功后旧 key 被清空,后续启动不再重复迁移。
	 */
	public async migrateFromWorkspaceState(
		memento: ChatSessionMemento,
		workspaceId: string
	): Promise<boolean> {
		const oldKey = `classmate.chatConversations.${workspaceId}`;
		const oldData = memento.get<PersistedChatData>(oldKey);
		if (!oldData || !this._isValidPersistedData(oldData)) {
			return false;
		}

		const current = await this.load();
		if (!current) {
			await this.save(oldData);
		}
		// 新存储已有数据时保留新数据,但不清除旧 key,避免旧数据丢失。
		// 新存储为空时才认为迁移完成并删除旧 key。
		if (!current) {
			await memento.update(oldKey, undefined);
		}
		return !current;
	}

	private _isValidPersistedData(value: unknown): value is PersistedChatData {
		if (typeof value !== 'object' || value === null) {
			return false;
		}
		const data = value as Record<string, unknown>;
		return (
			typeof data.activeConversationId === 'string' &&
			Array.isArray(data.conversations)
		);
	}
}
