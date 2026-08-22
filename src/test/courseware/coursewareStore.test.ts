import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { describe, it, after } from 'mocha';
import { CoursewareStore } from '../../courseware/coursewareStore';
import { CoursewareService } from '../../courseware/coursewareService';
import type { CoursewareGraph, CoursewareItem } from '../../courseware/types';

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
		version: 1,
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
