import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { describe, it, after } from 'mocha';
import { CoursewareStore } from '../../courseware/coursewareStore';
import { CoursewareService } from '../../courseware/coursewareService';
import { COURSEWARE_GRAPH_VERSION, type CoursewareGraph, type CoursewareItem } from '../../courseware/types';

/**
 * 内存版 workspaceState + 临时目录 globalStorage 的假 ExtensionContext。
 * 多个实例共享同一 context 即可模拟「同一工作区内重开面板/重启扩展」。
 */
function makeFakeContext(globalDir: string): vscode.ExtensionContext {
	const state = new Map<string, unknown>();
	return {
		workspaceState: {
			get: (key: string, fallback?: unknown) => state.get(key) ?? fallback,
			update: async (key: string, value: unknown) => {
				state.set(key, value);
			},
		},
		globalStorageUri: vscode.Uri.file(globalDir),
	} as unknown as vscode.ExtensionContext;
}

function makeItem(id: string): CoursewareItem {
	return {
		id,
		fileName: `${id}.pdf`,
		uri: vscode.Uri.file(path.join(os.tmpdir(), `${id}-missing.pdf`)).toString(),
		pageCount: 3,
		chunkCount: 2,
		addedAt: Date.now(),
	};
}

function makeGraph(nodeSourceId: string): CoursewareGraph {
	return {
		version: COURSEWARE_GRAPH_VERSION,
		updatedAt: Date.now(),
		nodes: [
			{
				chunkId: `${nodeSourceId}#0`,
				sourceId: nodeSourceId,
				fileName: `${nodeSourceId}.pdf`,
				pageStart: 1,
				pageEnd: 3,
				content: '二叉树的定义',
				keywords: ['二叉树'],
			},
		],
		edges: [],
	};
}

describe('courseware store/service 删除与重建语义', () => {
	const tempRoots: string[] = [];

	function newTempRoot(): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'classmate-courseware-store-'));
		tempRoots.push(dir);
		return dir;
	}

	after(() => {
		for (const dir of tempRoots) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it('removeItem 仅移除列表元数据，已保存的图文件原样保留', async () => {
		const context = makeFakeContext(newTempRoot());
		const store = new CoursewareStore(context);
		await store.saveGraph(makeGraph('src-a'));
		await store.addItem(makeItem('src-a'));
		await store.addItem(makeItem('src-b'));

		await store.removeItem('src-a');

		assert.deepStrictEqual(store.getItems().map((item) => item.id), ['src-b']);
		const graph = await store.loadGraph();
		assert.strictEqual(graph.nodes.length, 1);
		assert.strictEqual(graph.nodes[0].sourceId, 'src-a');
	});

	it('deleteCourseware 后列表消失而检索图保持旧版（跨实例=重开面板/重启扩展）', async () => {
		const context = makeFakeContext(newTempRoot());
		const prep = new CoursewareStore(context);
		await prep.addItem(makeItem('src-a'));
		await prep.saveGraph(makeGraph('src-a'));

		const service = new CoursewareService(context);
		await service.deleteCourseware('src-a');

		assert.strictEqual(service.items.length, 0);
		const graph = await service.loadGraph();
		assert.strictEqual(graph.nodes.length, 1);
		assert.ok(await service.retrieve('二叉树'));
	});

	it('重建以当前列表为准：删空的列表重建出空搜索图并落盘', async () => {
		const context = makeFakeContext(newTempRoot());
		const prep = new CoursewareStore(context);
		await prep.addItem(makeItem('src-a'));
		await prep.saveGraph(makeGraph('src-a'));
		const service = new CoursewareService(context);

		await service.deleteCourseware('src-a');
		const rebuilt = await service.rebuildGraphFromItems();

		assert.strictEqual(rebuilt.nodes.length, 0);
		assert.strictEqual(rebuilt.edges.length, 0);
		const persisted = await service.loadGraph();
		assert.strictEqual(persisted.nodes.length, 0);
	});

	it('重建只看当前列表：列表内坏文件不抛错，图被重建为当前列表可产出的内容', async () => {
		const context = makeFakeContext(newTempRoot());
		const prep = new CoursewareStore(context);
		// 图里预置一个旧课件节点，但导入列表里只有指向不存在文件的条目。
		await prep.saveGraph(makeGraph('src-old'));
		await prep.addItem(makeItem('src-missing-file'));
		const service = new CoursewareService(context);

		const rebuilt = await service.rebuildGraphFromItems();
		assert.strictEqual(rebuilt.nodes.length, 0);
		assert.strictEqual((await service.loadGraph()).nodes.length, 0);
		assert.deepStrictEqual(service.items.map((item) => item.id), ['src-missing-file']);
	});
});

describe('课件图版本迁移（期 1：version<2 丢弃旧图并提示重建）', () => {
	const tempRoots: string[] = [];

	function newTempRoot(): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'classmate-courseware-migration-'));
		tempRoots.push(dir);
		return dir;
	}

	after(() => {
		for (const dir of tempRoots) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it('version=1 旧结构图加载时被丢弃：空图 + needsRebuild 标记，检索为空', async () => {
		const context = makeFakeContext(newTempRoot());
		const prep = new CoursewareStore(context);
		await prep.saveGraph({ ...makeGraph('src-legacy'), version: 1 });

		const service = new CoursewareService(context);
		const graph = await service.loadGraph();
		assert.strictEqual(graph.nodes.length, 0);
		assert.strictEqual(graph.edges.length, 0);
		assert.strictEqual(graph.needsRebuild, true);
		assert.deepStrictEqual(await service.retrieve('二叉树'), []);
	});

	it('当前版本图原样加载，不带重建标记', async () => {
		const context = makeFakeContext(newTempRoot());
		const prep = new CoursewareStore(context);
		await prep.saveGraph(makeGraph('src-current'));

		const store = new CoursewareStore(context);
		const graph = await store.loadGraph();
		assert.strictEqual(graph.nodes.length, 1);
		assert.notStrictEqual(graph.needsRebuild, true);
	});

	it('无图文件（全新安装）不触发重建提示', async () => {
		const store = new CoursewareStore(makeFakeContext(newTempRoot()));
		const graph = await store.loadGraph();
		assert.strictEqual(graph.nodes.length, 0);
		assert.notStrictEqual(graph.needsRebuild, true);
	});

	it('期 2 version bump：version=2 旧结构图加载时同样被丢弃并提示重建', async () => {
		const context = makeFakeContext(newTempRoot());
		const prep = new CoursewareStore(context);
		await prep.saveGraph({ ...makeGraph('src-v2'), version: 2 });

		const service = new CoursewareService(context);
		const graph = await service.loadGraph();
		assert.strictEqual(graph.nodes.length, 0);
		assert.strictEqual(graph.needsRebuild, true);
		assert.deepStrictEqual(await service.retrieve('二叉树'), []);
	});
});
