import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { describe, it } from 'mocha';
import { CoursewareService } from '../../courseware/coursewareService';
import { CoursewareStore } from '../../courseware/coursewareStore';
import { COURSEWARE_GRAPH_VERSION, type CoursewareGraph } from '../../courseware/types';

/**
 * 期 2 服务级行为：多轮 query 并入上一轮 userText（开放问题 §4.1②）；
 * 注入空命中返回 ''（D8），占位块不再由课件侧注入。
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

function seededGraph(): CoursewareGraph {
	return {
		version: COURSEWARE_GRAPH_VERSION,
		updatedAt: Date.now(),
		nodes: [
			{
				chunkId: 'src-a#0',
				sourceId: 'src-a',
				fileName: 'lecture.pdf',
				pageStart: 4,
				pageEnd: 4,
				content: '死循环是指无法到达终止条件的循环，可通过断点或输出调试。',
				keywords: ['死循环'],
				title: '循环与递归',
				unitLabel: 'p.4',
			},
		],
		edges: [],
	};
}

async function newSeededService(): Promise<CoursewareService> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'classmate-retrieval-quality-'));
	const context = makeFakeContext(dir);
	await new CoursewareStore(context).saveGraph(seededGraph());
	return new CoursewareService(context);
}

describe('期 2 检索质量：多轮 query 并入与注入形态', () => {
	it('retrieveFormatted 并入上一轮 userText 后命中（单轮查询本身落空）', async () => {
		const service = await newSeededService();

		// 当轮提问只有指代省略的短语，词面与课件不相交 → 空命中返回 ''（不注入占位块）
		const singleTurn = await service.retrieveFormatted('它该怎么解决？');
		assert.strictEqual(singleTurn, '');

		// 并入上一轮提问后命中
		const merged = await service.retrieveFormatted('它该怎么解决？', 4, '程序陷入了死循环怎么办');
		assert.ok(merged.length > 0);
		assert.match(merged, /--- 《lecture\.pdf》 · 循环与递归 · p\.4 ---/);
	});

	it('空命中注入空串而非占位块，answer prompt 固定标题不受影响', async () => {
		const service = await newSeededService();

		assert.strictEqual(await service.retrieveFormatted('quantum computing 是什么'), '');
	});
});
