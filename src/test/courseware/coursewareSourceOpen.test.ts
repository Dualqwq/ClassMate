import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { afterEach, beforeEach, describe, it } from 'mocha';
import {
	openCoursewareChunkSource,
	parseStoredSourceRef,
	type CoursewareSourceOpenDeps,
} from '../../courseware/coursewareSourceOpener';
import { CoursewareService } from '../../courseware/coursewareService';
import { CoursewareStore } from '../../courseware/coursewareStore';
import { COURSEWARE_GRAPH_VERSION, type CoursewareGraph, type CoursewareItem } from '../../courseware/types';
import { ChatSession } from '../../chat/ChatSession';

/**
 * 溯源打开（期 1.5）单测：
 * - chunkId → 源文件定位 → 系统默认程序直开（fsPath）的宿主侧链路；
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

/** 模拟真实导入持久化形态：中文/空格路径经 uri.toString() 的百分号编码 URI 字符串。 */
function makeItemWithRawUri(id: string, rawUri: string, fileName: string): CoursewareItem {
	return {
		id,
		fileName,
		uri: rawUri,
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
	openedWith: string[];
	statFailed: boolean;
}

function makeDeps(existingPaths: Set<string>): RecordedDeps {
	const recorded: RecordedDeps = {
		openedWith: [],
		statFailed: false,
		openFile: async (fsPath) => {
			recorded.openedWith.push(fsPath);
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

	it('chunkId 定位到导入条目并按原生路径交给系统打开', async () => {
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
		assert.strictEqual(normalizeWinPath(deps.openedWith[0]), normalizeWinPath(filePath));
	});

	it('目标文件被移动/删除时返回 missing-file，不调用 openFile', async () => {
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

	it('中文与空格路径（真实持久化编码形态）解码后原样交给系统打开', async () => {
		// 用户实测数据形态：file:///c%3A/Users/.../%E6%99%BA.../Class04-CH02-Cycles-v1%20-%20%E5%8F%91%E5%B8%83.pdf
		const filePath = path.join(newTempRoot(), '课件 发布 版.pdf');
		fs.writeFileSync(filePath, 'pdf');
		const rawUri = vscode.Uri.file(filePath).toString();
		assert.ok(rawUri.includes('%'), '测试前置：持久化值应为百分号编码 URI 字符串');

		const context = newContext();
		const seed = new CoursewareStore(context);
		await seed.addItem(makeItemWithRawUri('src-zh', rawUri, path.basename(filePath)));
		await seed.saveGraph(makeGraph('src-zh#0', 'src-zh'));

		const deps = makeDeps(new Set([filePath]));
		const outcome = await openCoursewareChunkSource(new CoursewareService(context), 'src-zh#0', deps);

		assert.strictEqual(outcome, 'opened');
		assert.strictEqual(deps.openedWith.length, 1);
		// 交给系统的是解码后的原生路径，不是编码 URL 字符串。
		assert.strictEqual(normalizeWinPath(deps.openedWith[0]), normalizeWinPath(filePath));
		assert.ok(!/%[0-9A-Fa-f]{2}/.test(deps.openedWith[0]), '不得把百分号编码字符串当路径传给系统');
	});

	it('旧数据存纯绝对路径（非 URI 字符串）时归一化后仍可打开', async () => {
		const filePath = path.join(newTempRoot(), 'legacy.pdf');
		fs.writeFileSync(filePath, 'pdf');

		const context = newContext();
		const seed = new CoursewareStore(context);
		await seed.addItem(makeItemWithRawUri('src-plain', filePath, 'legacy.pdf'));
		await seed.saveGraph(makeGraph('src-plain#0', 'src-plain'));

		const deps = makeDeps(new Set([filePath]));
		const outcome = await openCoursewareChunkSource(new CoursewareService(context), 'src-plain#0', deps);

		assert.strictEqual(outcome, 'opened');
		assert.strictEqual(deps.openedWith.length, 1);
		assert.strictEqual(normalizeWinPath(deps.openedWith[0]), normalizeWinPath(filePath));
	});
});

describe('parseStoredSourceRef 输入形态归一化', () => {
	it('file:// URI 字符串按 Uri.parse 解码', () => {
		const uri = parseStoredSourceRef('file:///c%3A/dir/%E6%B5%8B%E8%AF%95%20a.pdf');
		assert.strictEqual(uri.scheme, 'file');
		assert.ok(uri.fsPath.includes('测试 a.pdf'));
	});

	it('纯 Windows 路径按 Uri.file 处理，盘符不被误判为 scheme', () => {
		const uri = parseStoredSourceRef('d:\\dir\\课件.pdf');
		assert.strictEqual(uri.scheme, 'file');
		assert.ok(/课件\.pdf$/.test(uri.fsPath));
	});

	it('正斜杠纯路径同样按文件路径处理', () => {
		const uri = parseStoredSourceRef('d:/dir/slides.pptx');
		assert.strictEqual(uri.scheme, 'file');
		assert.ok(/slides\.pptx$/.test(uri.fsPath));
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
