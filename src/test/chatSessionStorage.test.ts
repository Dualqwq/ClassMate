import * as assert from 'assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it } from 'mocha';
import { ChatSessionStorage, CHAT_SESSIONS_DIR, type ChatSessionMemento } from '../chat/chatSessionStorage';
import { hashStorageKey } from '../storage/runHistoryStore';
import type { PersistedChatData } from '../chat/types';

async function makeTempDir(): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), 'classmate-chat-session-'));
}

function makeFakeMemento(initial: Record<string, unknown> = {}): ChatSessionMemento {
	const store = { ...initial };
	return {
		get<T>(key: string): T | undefined {
			return store[key] as T | undefined;
		},
		async update(key: string, value?: unknown): Promise<void> {
			if (value === undefined) {
				delete store[key];
			} else {
				store[key] = value;
			}
		},
	};
}

function makeData(overrides: Partial<PersistedChatData> = {}): PersistedChatData {
	return {
		activeConversationId: 'conv-1',
		conversations: [
			{
				id: 'conv-1',
				title: 'hello',
				createdAt: 1,
				updatedAt: 2,
				messages: [],
				inputDraft: '',
			},
		],
		...overrides,
	};
}

describe('ChatSessionStorage (ADD3 会话迁移)', () => {
	it('工作区目录按 Uri hash,同 Uri 同目录', async () => {
		const base = await makeTempDir();
		try {
			const a = new ChatSessionStorage(base, 'file:///c/ws-a');
			const a2 = new ChatSessionStorage(base, 'file:///c/ws-a');
			const b = new ChatSessionStorage(base, 'file:///d/ws-b');
			assert.strictEqual(a.workspaceDir, a2.workspaceDir);
			assert.notStrictEqual(a.workspaceDir, b.workspaceDir);
			assert.ok(a.workspaceDir.includes(CHAT_SESSIONS_DIR));
			assert.ok(path.basename(a.workspaceDir).length === 16);
		} finally {
			await fs.rm(base, { recursive: true, force: true });
		}
	});

	it('无工作区时使用 single-file 占位', async () => {
		const base = await makeTempDir();
		try {
			const storage = new ChatSessionStorage(base, undefined);
			const expectedHash = hashStorageKey('single-file');
			assert.ok(storage.workspaceDir.endsWith(path.join(CHAT_SESSIONS_DIR, expectedHash)));
		} finally {
			await fs.rm(base, { recursive: true, force: true });
		}
	});

	it('save/load 往返', async () => {
		const base = await makeTempDir();
		try {
			const storage = new ChatSessionStorage(base, 'file:///c/ws');
			const data = makeData();
			await storage.save(data);
			const loaded = await storage.load();
			assert.deepStrictEqual(loaded, data);
			const file = path.join(storage.workspaceDir, 'conversations.json');
			assert.strictEqual((await fs.stat(file)).isFile(), true);
		} finally {
			await fs.rm(base, { recursive: true, force: true });
		}
	});

	it('load 对不存在目录返回 undefined', async () => {
		const base = await makeTempDir();
		try {
			const storage = new ChatSessionStorage(base, 'file:///c/nonexistent');
			const loaded = await storage.load();
			assert.strictEqual(loaded, undefined);
		} finally {
			await fs.rm(base, { recursive: true, force: true });
		}
	});

	it('migrateFromWorkspaceState 把旧数据写到新存储并清空旧 key', async () => {
		const base = await makeTempDir();
		try {
			const workspaceId = 'workspace-hash';
			const oldKey = `classmate.chatConversations.${workspaceId}`;
			const data = makeData();
			const memento = makeFakeMemento({ [oldKey]: data });
			const storage = new ChatSessionStorage(base, 'file:///c/ws');

			const migrated = await storage.migrateFromWorkspaceState(memento, workspaceId);

			assert.strictEqual(migrated, true);
			assert.deepStrictEqual(await storage.load(), data);
			assert.strictEqual(memento.get(oldKey), undefined);
		} finally {
			await fs.rm(base, { recursive: true, force: true });
		}
	});

	it('migrateFromWorkspaceState 幂等:第二次调用不再迁移', async () => {
		const base = await makeTempDir();
		try {
			const workspaceId = 'workspace-hash';
			const oldKey = `classmate.chatConversations.${workspaceId}`;
			const data = makeData();
			const memento = makeFakeMemento({ [oldKey]: data });
			const storage = new ChatSessionStorage(base, 'file:///c/ws');

			await storage.migrateFromWorkspaceState(memento, workspaceId);
			const second = await storage.migrateFromWorkspaceState(memento, workspaceId);

			assert.strictEqual(second, false);
			assert.deepStrictEqual(await storage.load(), data);
			assert.strictEqual(memento.get(oldKey), undefined);
		} finally {
			await fs.rm(base, { recursive: true, force: true });
		}
	});

	it('migrateFromWorkspaceState 在新存储已存在时保留新数据,不清旧 key', async () => {
		const base = await makeTempDir();
		try {
			const workspaceId = 'workspace-hash';
			const oldKey = `classmate.chatConversations.${workspaceId}`;
			const oldData = makeData({ activeConversationId: 'conv-old' });
			const newData = makeData({ activeConversationId: 'conv-new' });
			const memento = makeFakeMemento({ [oldKey]: oldData });
			const storage = new ChatSessionStorage(base, 'file:///c/ws');
			await storage.save(newData);

			const migrated = await storage.migrateFromWorkspaceState(memento, workspaceId);

			assert.strictEqual(migrated, false);
			assert.deepStrictEqual(await storage.load(), newData);
			assert.deepStrictEqual(memento.get(oldKey), oldData);
		} finally {
			await fs.rm(base, { recursive: true, force: true });
		}
	});

	it('migrateFromWorkspaceState 对不存在的旧 key 返回 false', async () => {
		const base = await makeTempDir();
		try {
			const memento = makeFakeMemento();
			const storage = new ChatSessionStorage(base, 'file:///c/ws');
			const migrated = await storage.migrateFromWorkspaceState(memento, 'no-data');
			assert.strictEqual(migrated, false);
			assert.strictEqual(await storage.load(), undefined);
		} finally {
			await fs.rm(base, { recursive: true, force: true });
		}
	});

	it('load 容忍损坏文件', async () => {
		const base = await makeTempDir();
		try {
			const storage = new ChatSessionStorage(base, 'file:///c/ws');
			await fs.mkdir(storage.workspaceDir, { recursive: true });
			await fs.writeFile(path.join(storage.workspaceDir, 'conversations.json'), '{broken json', 'utf8');
			const loaded = await storage.load();
			assert.strictEqual(loaded, undefined);
		} finally {
			await fs.rm(base, { recursive: true, force: true });
		}
	});
});
