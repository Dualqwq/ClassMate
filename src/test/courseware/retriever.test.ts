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
