import * as assert from 'assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it } from 'mocha';
import {
	hashStorageKey,
	normalizeExePathKey,
	RunHistoryStore,
	RUN_HISTORY_LIMIT,
	truncateOutput,
} from '../storage/runHistoryStore';
import type { RunRecord } from '../run/types';

function makeRecord(overrides: Partial<RunRecord> = {}): RunRecord {
	return {
		id: overrides.id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
		exePath: overrides.exePath ?? 'C:/ws/app.exe',
		startedAt: overrides.startedAt ?? Date.now(),
		durationMs: 12,
		exitCode: 0,
		timedOut: false,
		needsInteractiveInput: false,
		stdin: '',
		stdout: 'hello',
		stderr: '',
		outputTruncated: false,
		...overrides,
	};
}

async function makeTempDir(): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), 'classmate-run-history-'));
}

describe('truncateOutput (64KB 头尾截断)', () => {
	it('未超限原文保留', () => {
		const result = truncateOutput('short output');
		assert.strictEqual(result.truncated, false);
		assert.strictEqual(result.text, 'short output');
	});

	it('超限后头尾各留一半,中间插省略标记', () => {
		const head = 'H'.repeat(40 * 1024);
		const middle = 'M'.repeat(40 * 1024);
		const tail = 'T'.repeat(40 * 1024);
		const result = truncateOutput(head + middle + tail);
		assert.strictEqual(result.truncated, true);
		assert.ok(result.omittedBytes > 0);
		assert.ok(result.text.startsWith('H'.repeat(100)), '头部保留');
		assert.ok(result.text.endsWith('T'.repeat(100)), '尾部保留');
		assert.match(result.text, /…\d+ bytes 省略…/);
		// 持久化体积有界:头尾各 ≤32KB + 标记
		assert.ok(Buffer.byteLength(result.text, 'utf8') <= 64 * 1024 + 64);
	});

	it('多字节字符不被劈开(无替换符)', () => {
		const chunk = '中文输出测试';
		const text = chunk.repeat(20000); // ~ 480KB UTF-8
		const result = truncateOutput(text);
		assert.strictEqual(result.truncated, true);
		assert.ok(!result.text.includes('�'), `出现乱码替换符: ${result.text.slice(0, 200)}`);
		assert.match(result.text, /…\d+ bytes 省略…/);
	});
});

describe('RunHistoryStore (ADD3 原语 + 环形历史)', () => {
	it('hash 输入 = 工作区 Uri:同 Uri 同目录,异 Uri 异目录', async () => {
		const base = await makeTempDir();
		try {
			const a = new RunHistoryStore(base, 'file:///c/ws-a');
			const a2 = new RunHistoryStore(base, 'file:///c/ws-a');
			const b = new RunHistoryStore(base, 'file:///d/ws-b');
			assert.strictEqual(a.workspaceDir, a2.workspaceDir);
			assert.notStrictEqual(a.workspaceDir, b.workspaceDir);
			assert.ok(a.workspaceDir.includes('run-history'));
		} finally {
			await fs.rm(base, { recursive: true, force: true });
		}
	});

	it('追加写 + 读回(JSONL 逐 exe 一条)', async () => {
		const base = await makeTempDir();
		try {
			const store = new RunHistoryStore(base, 'file:///c/ws');
			await store.append(makeRecord({ exePath: 'C:/ws/app.exe', stdout: 'run1' }));
			await store.append(makeRecord({ exePath: 'C:/ws/app.exe', stdout: 'run2' }));
			const records = await store.list('C:/ws/app.exe');
			assert.strictEqual(records.length, 2);
			assert.strictEqual(records[0].stdout, 'run1');
			assert.strictEqual(records[1].stdout, 'run2');
			// 文件确为 JSONL:两行,逐行可解析
			const files = await fs.readdir(store.workspaceDir);
			assert.strictEqual(files.length, 1);
			assert.ok(files[0].endsWith('.jsonl'));
			const raw = await fs.readFile(path.join(store.workspaceDir, files[0]), 'utf8');
			const lines = raw.trim().split('\n');
			assert.strictEqual(lines.length, 2);
			for (const line of lines) {
				JSON.parse(line);
			}
		} finally {
			await fs.rm(base, { recursive: true, force: true });
		}
	});

	it('每 exe 环形保留最近 20 次', async () => {
		const base = await makeTempDir();
		try {
			const store = new RunHistoryStore(base, 'file:///c/ws');
			for (let i = 0; i < RUN_HISTORY_LIMIT + 5; i++) {
				await store.append(makeRecord({ exePath: 'C:/ws/app.exe', stdout: `run-${i}`, startedAt: i }));
			}
			const records = await store.list('C:/ws/app.exe');
			assert.strictEqual(records.length, RUN_HISTORY_LIMIT);
			assert.strictEqual(records[0].stdout, 'run-5', '最旧的 5 条被挤出');
			assert.strictEqual(records[records.length - 1].stdout, `run-${RUN_HISTORY_LIMIT + 4}`);
		} finally {
			await fs.rm(base, { recursive: true, force: true });
		}
	});

	it('不同 exe 各自一条历史(键 = 工作区 Uri + exe 绝对路径)', async () => {
		const base = await makeTempDir();
		try {
			const store = new RunHistoryStore(base, 'file:///c/ws');
			await store.append(makeRecord({ exePath: 'C:/ws/a.exe', stdout: 'A' }));
			await store.append(makeRecord({ exePath: 'C:/ws/b.exe', stdout: 'B' }));
			assert.strictEqual((await store.list('C:/ws/a.exe')).length, 1);
			assert.strictEqual((await store.list('C:/ws/b.exe')).length, 1);
			const executables = await store.listExecutables();
			assert.deepStrictEqual(executables.sort(), ['C:/ws/a.exe', 'C:/ws/b.exe']);
			const all = await store.readAll();
			assert.strictEqual(all.length, 2);
		} finally {
			await fs.rm(base, { recursive: true, force: true });
		}
	});

	if (process.platform === 'win32') {
		it('Windows 上 exe 路径键大小写/分隔符归一', () => {
			assert.strictEqual(
				normalizeExePathKey('C:\\WS\\App.exe'),
				normalizeExePathKey('c:/ws/app.exe')
			);
		});
	}

	it('容忍损坏行', async () => {
		const base = await makeTempDir();
		try {
			const store = new RunHistoryStore(base, 'file:///c/ws');
			await store.append(makeRecord({ exePath: 'C:/ws/app.exe' }));
			const files = await fs.readdir(store.workspaceDir);
			await fs.appendFile(path.join(store.workspaceDir, files[0]), '{broken json\n');
			const records = await store.list('C:/ws/app.exe');
			assert.strictEqual(records.length, 1);
		} finally {
			await fs.rm(base, { recursive: true, force: true });
		}
	});

	it('hashStorageKey 稳定且 16 位', () => {
		const a = hashStorageKey('file:///c/ws');
		assert.strictEqual(a.length, 16);
		assert.strictEqual(a, hashStorageKey('file:///c/ws'));
		assert.notStrictEqual(a, hashStorageKey('file:///c/ws2'));
	});
});
