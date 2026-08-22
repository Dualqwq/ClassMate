import * as assert from 'assert';
import { describe, it } from 'mocha';
import { buildCoursewareGraph } from '../../courseware/graphBuilder';
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
		assert.strictEqual(graph.edges[0].reason, 'sequential');
		assert.strictEqual(graph.version, 2);
	});

	it('creates keyword-overlap edges between related chunks', () => {
		const chunks: CoursewareChunk[] = [
			makeChunk('a#0', 'a', 'linked list node', ['linked', 'list', 'node']),
			makeChunk('b#0', 'b', 'list traversal', ['list', 'traversal']),
		];
		const graph = buildCoursewareGraph(chunks);
		const overlapEdges = graph.edges.filter((edge) => edge.reason === 'keyword-overlap');
		assert.strictEqual(overlapEdges.length, 1);
		assert.ok(overlapEdges[0].weight > 0);
	});

	it('does not create keyword-overlap edges without shared keywords', () => {
		const chunks: CoursewareChunk[] = [
			makeChunk('a#0', 'a', 'recursion', ['recursion', 'base']),
			makeChunk('b#0', 'b', 'greedy algorithm', ['greedy', 'optimal']),
		];
		const graph = buildCoursewareGraph(chunks);
		const overlapEdges = graph.edges.filter((edge) => edge.reason === 'keyword-overlap');
		assert.strictEqual(overlapEdges.length, 0);
	});

	it('adds sequential and same-source edges within a source', () => {
		const chunks: CoursewareChunk[] = [
			makeChunk('a#0', 'a', 'first', ['a']),
			makeChunk('a#1', 'a', 'second', ['a']),
			makeChunk('a#2', 'a', 'third', ['a']),
		];
		const graph = buildCoursewareGraph(chunks);
		const sequential = graph.edges.filter((edge) => edge.reason === 'sequential');
		const sameSource = graph.edges.filter((edge) => edge.reason === 'same-source');
		assert.strictEqual(sequential.length, 2);
		assert.strictEqual(sameSource.length, 1);
	});
});
