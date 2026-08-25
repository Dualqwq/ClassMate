import * as assert from 'assert';
import { describe, it } from 'mocha';
import { buildCoursewareGraph, extractDefinedTerms, TOC_CHUNK_ID_SUFFIX } from '../../courseware/graphBuilder';
import type { CoursewareChunk } from '../../courseware/types';

function makeChunk(id: string, sourceId: string, content: string, keywords: string[], page = 1): CoursewareChunk {
	return {
		chunkId: id,
		sourceId,
		fileName: `${sourceId}.pdf`,
		pageStart: page,
		pageEnd: page,
		content,
		keywords,
	};
}

describe('courseware graph builder', () => {
	it('creates nodes for every chunk', () => {
		const chunks: CoursewareChunk[] = [
			makeChunk('a#0', 'a', 'pointer basics', ['pointer', 'address']),
			makeChunk('a#1', 'a', 'pointer arithmetic', ['pointer', 'arithmetic']),
		];
		const graph = buildCoursewareGraph(chunks);
		assert.strictEqual(graph.nodes.length, 2);
		assert.strictEqual(graph.edges.length, 1);
		assert.strictEqual(graph.edges[0].reason, 'precedes');
		assert.strictEqual(graph.version, 3);
	});

	it('creates mentions edges between related chunks（原 keyword-overlap 类型化改名）', () => {
		const chunks: CoursewareChunk[] = [
			makeChunk('a#0', 'a', 'linked list node', ['linked', 'list', 'node']),
			makeChunk('b#0', 'b', 'list traversal', ['list', 'traversal']),
		];
		const graph = buildCoursewareGraph(chunks);
		const mentionEdges = graph.edges.filter((edge) => edge.reason === 'mentions');
		assert.strictEqual(mentionEdges.length, 1);
		assert.ok(mentionEdges[0].weight > 0);
	});

	it('does not create mention edges without shared keywords', () => {
		const chunks: CoursewareChunk[] = [
			makeChunk('a#0', 'a', 'recursion', ['recursion', 'base']),
			makeChunk('b#0', 'b', 'greedy algorithm', ['greedy', 'optimal']),
		];
		const graph = buildCoursewareGraph(chunks);
		const mentionEdges = graph.edges.filter((edge) => edge.reason === 'mentions');
		assert.strictEqual(mentionEdges.length, 0);
	});

	it('adds precedes and same-source edges within a source', () => {
		const chunks: CoursewareChunk[] = [
			makeChunk('a#0', 'a', 'first', ['first']),
			makeChunk('a#1', 'a', 'second', ['second']),
			makeChunk('a#2', 'a', 'third', ['third']),
		];
		const graph = buildCoursewareGraph(chunks);
		const precedes = graph.edges.filter((edge) => edge.reason === 'precedes');
		const sameSource = graph.edges.filter((edge) => edge.reason === 'same-source');
		assert.strictEqual(precedes.length, 2);
		assert.strictEqual(sameSource.length, 1);
	});
});

describe('期 2 检索层：类型化实体关系边与 TOC 摘要节点', () => {
	it('定义模式锚定：中文「X 是指」抽出术语且限定在关键词集内（封闭锚点）', () => {
		assert.deepStrictEqual(
			extractDefinedTerms('二叉树是指每个结点最多有两个孩子的树形结构。', ['二叉树', '结点']),
			['二叉树']
		);
		// 候选不在关键词集内 → 不产出（防止自由抽取噪声实体）
		assert.deepStrictEqual(extractDefinedTerms('动态规划是指一种优化方法。', ['贪心']), []);
	});

	it('defines 边连接定义块与提及块', () => {
		const chunks: CoursewareChunk[] = [
			makeChunk('def#0', 'def', '循环群是指由一个生成元生成的群。', ['循环群', '生成元'], 3),
			makeChunk('use#0', 'use', '循环群的子群仍是循环群。', ['循环群', '子群'], 1),
		];
		const graph = buildCoursewareGraph(chunks);
		const defines = graph.edges.filter((edge) => edge.reason === 'defines');
		assert.strictEqual(defines.length, 1);
		const pair = [defines[0].from, defines[0].to].sort();
		assert.deepStrictEqual(pair, ['def#0', 'use#0']);
	});

	it('≥3 chunk 的课件生成 TOC 摘要节点，chunk 经 belongs_to 边从属于它', () => {
		const chunks: CoursewareChunk[] = [
			makeChunk('s#0', 's', '第一章 链表', ['链表'], 1),
			makeChunk('s#1', 's', '第二章 栈与队列', ['栈'], 2),
			makeChunk('s#2', 's', '第三章 排序', ['排序'], 3),
		];
		const graph = buildCoursewareGraph(chunks);
		const toc = graph.nodes.find((node) => node.chunkId === `s${TOC_CHUNK_ID_SUFFIX}`);
		assert.ok(toc, 'TOC 节点必须存在');
		assert.strictEqual(toc.title, '目录');
		const belongsTo = graph.edges.filter((edge) => edge.reason === 'belongs_to');
		assert.strictEqual(belongsTo.length, 3);
		assert.ok(belongsTo.every((edge) => edge.from !== toc.chunkId && edge.to === toc.chunkId));
	});

	it('<3 chunk 的课件不建 TOC 节点（目录无增量信息）', () => {
		const chunks: CoursewareChunk[] = [
			makeChunk('t#0', 't', '唯一一页', ['链表'], 1),
			makeChunk('t#1', 't', '第二页', ['栈'], 2),
		];
		const graph = buildCoursewareGraph(chunks);
		assert.ok(!graph.nodes.some((node) => node.chunkId.endsWith(TOC_CHUNK_ID_SUFFIX)));
		assert.strictEqual(graph.edges.filter((edge) => edge.reason === 'belongs_to').length, 0);
	});

	it('buildCoursewareGraph 不修改调用方传入的 chunk 数组', () => {
		const chunks: CoursewareChunk[] = [
			makeChunk('m#0', 'm', '一', ['链表'], 1),
			makeChunk('m#1', 'm', '二', ['栈'], 2),
			makeChunk('m#2', 'm', '三', ['队列'], 3),
		];
		buildCoursewareGraph(chunks);
		assert.strictEqual(chunks.length, 3);
	});
});
