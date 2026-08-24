import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { afterEach, beforeEach, describe, it } from 'mocha';
import {
	openCoursewareChunkSource,
	type CoursewareSourceOpenDeps,
} from '../../courseware/coursewareSourceOpener';
import { CoursewareService } from '../../courseware/coursewareService';
import { CoursewareStore } from '../../courseware/coursewareStore';
import { COURSEWARE_GRAPH_VERSION, type CoursewareGraph, type CoursewareItem } from '../../courseware/types';
import { ChatSession } from '../../chat/ChatSession';

/**
 * 溯源打开（期 1.5）单测：
 * - chunkId → 源文件定位 → openExternal 的宿主侧链路；
 * - 文件被移动/删除时的明确提示路径（不静默失败）；
 * - 导入列表绝对路径字段的读写往返。
 */

function makeFakeContext(): vscode.ExtensionContext {
	const state = new Map<string, unknown>();
	return {
		workspaceState: {
			get: (key: string, fallback?: unknown) => state.get(key) ?? fallback,
			update: async (key: string, value: unknown) => {
				state.set(key, value);
			},
		},
		globalStorageUri: vscode.Uri.file(fs.mkdtempSync(path.join(os.tmpdir(), 'classmate-source-open-'))),
	} as unknown as vscode.ExtensionContext;
}

function makeItem(id: string, filePath: string): CoursewareItem {
	return {
		id,
		fileName: path.basename(filePath),
		uri: vscode.Uri.file(filePath).toString(),
		pageCount: 3,
		chunkCount: 1,
		addedAt: Date.now(),
	};
}

/** Windows 下 vscode.Uri.fsPath 会把盘符转小写，路径断言统一小写比较。 */
function normalizeWinPath(p: string): string {
	return p.replace(/\//g, '\\').toLowerCase();
}

function makeGraph(chunkId: string, sourceId: string): CoursewareGraph {
	return {
		version: COURSEWARE_GRAPH_VERSION,
		updatedAt: Date.now(),
		nodes: [
			{
				chunkId,
				sourceId,
				fileName: `${sourceId}.pdf`,
				pageStart: 2,
				pageEnd: 2,
				content: '二叉树的定义',
				keywords: ['二叉树'],
			},
		],
		edges: [],
	};
}

interface RecordedDeps extends CoursewareSourceOpenDeps {
	openedWith: vscode.Uri[];
	statFailed: boolean;
}

function makeDeps(existingPaths: Set<string>): RecordedDeps {
	const recorded: RecordedDeps = {
		openedWith: [],
		statFailed: false,
		openExternal: async (uri) => {
			recorded.openedWith.push(uri);
			return true;
		},
		stat: async (uri) => {
			if (![...existingPaths].map(normalizeWinPath).includes(normalizeWinPath(uri.fsPath))) {
				recorded.statFailed = true;
				throw new Error('File not found');
			}
			return { type: 1 };
		},
	};
	return recorded;
}

describe('课件溯源打开（期 1.5）', () => {
	const tempRoots: string[] = [];
	function newTempRoot(): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'classmate-source-open-'));
		tempRoots.push(dir);
		return dir;
	}
	const contexts: vscode.ExtensionContext[] = [];
	function newContext(): vscode.ExtensionContext {
		const context = makeFakeContext();
		contexts.push(context);
		return context;
	}

	it('chunkId 定位到导入条目并经 openExternal 打开绝对路径', async () => {
		const filePath = path.join(newTempRoot(), 'lecture.pdf');
		fs.writeFileSync(filePath, 'pdf');
		const context = newContext();
		const seed = new CoursewareStore(context);
		await seed.addItem(makeItem('src-a', filePath));
		await seed.saveGraph(makeGraph('src-a#0', 'src-a'));

		const deps = makeDeps(new Set([filePath]));
		const outcome = await openCoursewareChunkSource(new CoursewareService(context), 'src-a#0', deps);

		assert.strictEqual(outcome, 'opened');
		assert.strictEqual(deps.openedWith.length, 1);
		assert.strictEqual(normalizeWinPath(deps.openedWith[0].fsPath), normalizeWinPath(filePath));
	});

	it('目标文件被移动/删除时返回 missing-file，不调用 openExternal', async () => {
		const missingPath = path.join(newTempRoot(), 'gone.pdf');
		const context = newContext();
		const seed = new CoursewareStore(context);
		await seed.addItem(makeItem('src-b', missingPath));
		await seed.saveGraph(makeGraph('src-b#0', 'src-b'));

		const deps = makeDeps(new Set());
		const outcome = await openCoursewareChunkSource(new CoursewareService(context), 'src-b#0', deps);

		assert.strictEqual(outcome, 'missing-file');
		assert.strictEqual(deps.openedWith.length, 0);
		assert.ok(deps.statFailed);
	});

	it('chunkId 无对应导入条目（课件已移除/图待重建）返回 unknown-chunk', async () => {
		const context = newContext();
		const seed = new CoursewareStore(context);
		await seed.saveGraph(makeGraph('src-removed#0', 'src-removed'));

		const deps = makeDeps(new Set());
		const outcome = await openCoursewareChunkSource(new CoursewareService(context), 'src-removed#0', deps);

		assert.strictEqual(outcome, 'unknown-chunk');
		assert.strictEqual(deps.openedWith.length, 0);
	});

	it('导入条目的绝对路径读写往返保持不变', async () => {
		const filePath = path.join(newTempRoot(), 'slides.pptx');
		const context = newContext();
		// 写入实例：模拟 importPdf 持久化 uri.toString() 绝对文件 URI。
		await new CoursewareStore(context).addItem(makeItem('src-c', filePath));
		// 新实例读取：模拟重启扩展后从 workspaceState 恢复。
		const item = new CoursewareService(context).getItem('src-c');

		assert.ok(item);
		const parsed = vscode.Uri.parse(item.uri);
		assert.ok(path.isAbsolute(parsed.fsPath), '恢复后的路径必须是绝对路径');
		assert.strictEqual(normalizeWinPath(parsed.fsPath), normalizeWinPath(filePath));
	});
});

describe('chat 侧 openCoursewareSource 消息链路', () => {
	let openedChunkIds: string[];

	beforeEach(() => {
		ChatSession.resetInstance();
		openedChunkIds = [];
	});

	afterEach(() => {
		ChatSession.resetInstance();
	});

	it('webview 消息经 ChatSession 分发到溯源处理器', () => {
		const session = ChatSession.getInstance();
		session.setCoursewareSourceHandler((chunkId) => openedChunkIds.push(chunkId));

		session.handleWebviewMessage({ type: 'openCoursewareSource', chunkId: 'src-a#3' });

		assert.deepStrictEqual(openedChunkIds, ['src-a#3']);
	});

	it('未设置处理器时不抛错（旧版本兼容路径）', () => {
		const session = ChatSession.getInstance();
		session.handleWebviewMessage({ type: 'openCoursewareSource', chunkId: 'anything#0' });
		assert.deepStrictEqual(openedChunkIds, []);
	});
});
