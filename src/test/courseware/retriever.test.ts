import * as assert from 'assert';
import { describe, it } from 'mocha';
import { retrieveCoursewareChunks, formatRetrievalResults } from '../../courseware/retriever';
import { buildCoursewareGraph } from '../../courseware/graphBuilder';
import type { CoursewareChunk, CoursewareGraph } from '../../courseware/types';

function makeChunk(id: string, sourceId: string, content: string, keywords: string[]): CoursewareChunk {
	return {
		chunkId: id,
		sourceId,
		fileName: `${sourceId}.pdf`,
		pageStart: 1,
		pageEnd: 1,
		content,
		keywords,
	};
}

describe('courseware retriever', () => {
	function buildSampleGraph(): CoursewareGraph {
		return buildCoursewareGraph([
			makeChunk('intro#0', 'intro', 'A pointer stores a memory address.', ['pointer', 'memory', 'address']),
			makeChunk('intro#1', 'intro', 'Dereferencing a pointer reads the value at that address.', ['pointer', 'dereference', 'value']),
			makeChunk('oop#0', 'oop', 'A class defines a blueprint for objects.', ['class', 'object', 'blueprint']),
		]);
	}

	it('returns relevant chunks for a keyword query', () => {
		const graph = buildSampleGraph();
		const results = retrieveCoursewareChunks(graph, 'what is a pointer', 2);
		assert.ok(results.length > 0);
		assert.ok(results[0].content.toLowerCase().includes('pointer'));
	});

	it('ranks keyword-matching chunks higher than content-only matches', () => {
		const graph = buildSampleGraph();
		const results = retrieveCoursewareChunks(graph, 'pointer memory', 2);
		assert.strictEqual(results[0].chunkId, 'intro#0');
		assert.ok(results[0].score >= results[results.length - 1].score);
	});

	it('propagates scores along graph edges', () => {
		const graph = buildSampleGraph();
		const results = retrieveCoursewareChunks(graph, 'pointer', 3);
		const ids = results.map((r) => r.chunkId);
		assert.ok(ids.includes('intro#0'));
		assert.ok(ids.includes('intro#1'));
	});

	it('returns empty results for unrelated queries', () => {
		const graph = buildSampleGraph();
		const results = retrieveCoursewareChunks(graph, 'quantum physics', 2);
		assert.strictEqual(results.length, 0);
	});

	it('returns chunks for a single CJK character query', () => {
		const graph = buildCoursewareGraph([
			makeChunk('tree#0', 'tree', '二叉树是一种重要的树形结构，每个结点最多有两个孩子。', ['二叉树', '树形', '结点']),
			makeChunk('oop#0', 'oop', 'A class defines a blueprint for objects.', ['class', 'object']),
		]);
		const results = retrieveCoursewareChunks(graph, '树', 3);
		assert.ok(results.length > 0);
		assert.strictEqual(results[0].chunkId, 'tree#0');
	});

	it('ranks chunks with denser single-character matches first', () => {
		const graph = buildCoursewareGraph([
			makeChunk('dense#0', 'dense', '树的性质 树的遍历 树的计数 树的存储 树的应用', ['树的性质', '树的遍历']),
			makeChunk('sparse#0', 'sparse', '森林与树的概念辨析。', ['森林', '概念']),
		]);
		const results = retrieveCoursewareChunks(graph, '树', 2);
		assert.ok(results.length === 2);
		assert.strictEqual(results[0].chunkId, 'dense#0');
		assert.ok(results[0].score > results[1].score);
	});


	it('formats results into a prompt block', () => {
		const graph = buildSampleGraph();
		const results = retrieveCoursewareChunks(graph, 'pointer', 2);
		const formatted = formatRetrievalResults(results);
		assert.match(formatted, /Courseware context/);
		assert.match(formatted, /pointer/i);
		assert.match(formatted, /Use the above courseware fragments/);
	});

	it('formats empty results gracefully', () => {
		const formatted = formatRetrievalResults([]);
		assert.match(formatted, /No matching courseware fragments found/);
	});
});

describe('期 2 检索层（D6/D7）：查询统一分词 / same-source 退出评分 / top-k 分散 / TOC 可检索', () => {
	function makeChunk(id: string, sourceId: string, content: string, keywords: string[], title?: string): CoursewareChunk {
		return {
			chunkId: id,
			sourceId,
			fileName: `${sourceId}.pdf`,
			pageStart: 1,
			pageEnd: 1,
			content,
			keywords,
			title,
		};
	}

	it('查询侧与索引侧同一分词器：英文别名扩展命中中文课件（D7）', () => {
		const graph = buildCoursewareGraph([
			makeChunk('mst#0', 'mst', '最小生成树的 Prim 算法从任意起点开始生长。', ['最小生成树']),
		]);
		// 旧 n-gram 查询侧只抽出 'mst'，与中文词面不相交必然落空；现经别名组扩展命中。
		const results = retrieveCoursewareChunks(graph, 'how does MST work', 4);
		assert.ok(results.length > 0);
		assert.strictEqual(results[0].chunkId, 'mst#0');
	});

	it('基础英文别名命中中文课件：Tree/Cycle/Graph/Node', () => {
		const graph = buildCoursewareGraph([
			makeChunk('tree-basic#0', 'tree-basic', '树是一类连通且没有回路的图。', ['树']),
			makeChunk('cycle-basic#0', 'cycle-basic', '回路是从起点出发又返回起点的道路。', ['回路']),
			makeChunk('graph-basic#0', 'graph-basic', '图由结点和边组成。', ['图', '结点']),
		]);

		assert.strictEqual(retrieveCoursewareChunks(graph, 'Tree', 4)[0]?.chunkId, 'tree-basic#0');
		assert.strictEqual(retrieveCoursewareChunks(graph, 'Cycle', 4)[0]?.chunkId, 'cycle-basic#0');
		assert.strictEqual(retrieveCoursewareChunks(graph, 'Graph', 4)[0]?.chunkId, 'graph-basic#0');
		assert.strictEqual(retrieveCoursewareChunks(graph, 'Node', 4)[0]?.chunkId, 'graph-basic#0');
	});

	it('Cycle 的真实回路片段排在循环群/死循环的单字弱命中之前', () => {
		const graph = buildCoursewareGraph([
			makeChunk('cycle#0', 'cycle', '回路是从起点出发又返回起点的道路。', ['回路']),
			makeChunk('cyclic-group#0', 'cyclic-group', '循环群由一个生成元生成。', ['循环群']),
			makeChunk('infinite-loop#0', 'infinite-loop', '死循环会让程序无法结束。', ['死循环']),
		]);

		const results = retrieveCoursewareChunks(graph, 'Cycle', 4);
		assert.strictEqual(results[0]?.chunkId, 'cycle#0');
		for (const weakMatch of ['cyclic-group#0', 'infinite-loop#0']) {
			const index = results.findIndex((result) => result.chunkId === weakMatch);
			assert.ok(index === -1 || index > 0, `${weakMatch} 不得排在真实回路片段之前`);
		}
	});

	it('查询侧不再产生 n-gram 碎片词', () => {
		const graph = buildCoursewareGraph([
			makeChunk('noise#0', 'noise', '完全无关的内容。', ['无关']),
		]);
		// 「道路与回」这类旧伪词来自查询侧相邻字组合，现不应再出现在查询词里。
		const results = retrieveCoursewareChunks(graph, '道路与回路', 4);
		assert.strictEqual(results.length, 0);
	});

	it('same-source 边不参与传播：非相邻同源块不被间接加分（D6）', () => {
		const graph = buildCoursewareGraph([
			makeChunk('s#0', 's', '循环群的定义与例子', ['循环群']),
			makeChunk('s#1', 's', '陪集与商群', ['陪集']),
			makeChunk('s#2', 's', '群同构的基本概念', ['同构']),
		]);
		const results = retrieveCoursewareChunks(graph, '循环群', 4);
		const ids = results.map((r) => r.chunkId);
		assert.ok(ids.includes('s#0'));
		// s#1 经 precedes 边传播可达；s#2 只与 s#0 有 same-source 边，必须保持零分。
		assert.ok(!ids.includes('s#2'), 'same-source 边不得参与排序传播');
	});

	it('top-k 按 (sourceId) 分散：单一课件最多占 ⌈topK/2⌉ 席（D6）', () => {
		const chunks = [
			makeChunk('x#0', 'x', '二叉树的定义 二叉树的性质', ['二叉树']),
			makeChunk('x#1', 'x', '二叉树的存储 二叉树的遍历', ['二叉树']),
			makeChunk('x#2', 'x', '二叉树的线索化 二叉树的还原', ['二叉树']),
			makeChunk('y#0', 'y', '二叉树的一种应用场景', ['二叉树']),
			makeChunk('z#0', 'z', '二叉树与森林的转换', ['二叉树']),
		];
		const graph = buildCoursewareGraph(chunks);
		const results = retrieveCoursewareChunks(graph, '二叉树', 4);
		assert.strictEqual(results.length, 4);
		const fromX = results.filter((r) => r.sourceId === 'x');
		assert.strictEqual(fromX.length, 2, '⌈4/2⌉=2：x 最多占两席');
		assert.ok(results.some((r) => r.sourceId === 'y'));
		assert.ok(results.some((r) => r.sourceId === 'z'));
	});

	it('其他来源候选耗尽时允许超额课件回填补位（小图不缺结果）', () => {
		const graph = buildCoursewareGraph([
			makeChunk('only#a', 'only', '二叉树 A', ['二叉树']),
			makeChunk('only#b', 'only', '二叉树 B', ['二叉树']),
			makeChunk('only#c', 'only', '二叉树 C', ['二叉树']),
			makeChunk('only#d', 'only', '二叉树 D', ['二叉树']),
		]);
		const results = retrieveCoursewareChunks(graph, '二叉树', 4);
		assert.strictEqual(results.length, 4, '只有单来源时仍应填满 topK');
	});

	it('TOC 摘要节点可被检索（期 2 最小版）', () => {
		const graph = buildCoursewareGraph([
			makeChunk('t#0', 't', '第一章 链表', ['链表'], '链表'),
			makeChunk('t#1', 't', '第二章 栈与队列', ['栈'], '栈与队列'),
			makeChunk('t#2', 't', '第三章 排序', ['排序'], '排序'),
		]);
		const results = retrieveCoursewareChunks(graph, '目录', 4);
		assert.ok(results.length > 0);
		assert.ok(results[0].chunkId.endsWith('#toc'), '目录查询应首先命中 TOC 节点');
	});
});
