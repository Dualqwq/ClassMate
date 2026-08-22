import type { CoursewareChunk, CoursewareEdge, CoursewareGraph } from './types';

/**
 * 基于 chunk 关键词共现构建轻量 GraphRAG 图。
 * 边类型：
 * - keyword-overlap：跨源 chunk 共享关键词；权重=共享数/min(关键词数)。
 *   同源相邻 chunk 的关系由 sequential 表达，不再额外生成 keyword-overlap。
 * - same-source：同一课件内非相邻 chunk；权重=0.3。
 * - sequential：同一课件内相邻 chunk；权重=0.5。
 */
export function buildCoursewareGraph(chunks: CoursewareChunk[]): CoursewareGraph {
	const edges: CoursewareEdge[] = [];
	const edgeKeySet = new Set<string>();
	const keywordToChunks = new Map<string, Set<string>>();

	for (const chunk of chunks) {
		for (const keyword of chunk.keywords) {
			const set = keywordToChunks.get(keyword) ?? new Set<string>();
			set.add(chunk.chunkId);
			keywordToChunks.set(keyword, set);
		}
	}

	function addEdge(from: string, to: string, weight: number, reason: CoursewareEdge['reason']): void {
		if (from === to) {
			return;
		}
		const key = `${[from, to].sort().join('|')}::${reason}`;
		if (edgeKeySet.has(key)) {
			return;
		}
		edgeKeySet.add(key);
		edges.push({ from, to, weight, reason });
	}

	// 按 source 分组并排序，用于判断同源相邻关系
	const bySource = new Map<string, CoursewareChunk[]>();
	for (const chunk of chunks) {
		const list = bySource.get(chunk.sourceId) ?? [];
		list.push(chunk);
		bySource.set(chunk.sourceId, list);
	}
	for (const list of bySource.values()) {
		list.sort((a, b) => a.chunkId.localeCompare(b.chunkId));
	}

	function areSequential(a: CoursewareChunk, b: CoursewareChunk): boolean {
		if (a.sourceId !== b.sourceId) {
			return false;
		}
		const list = bySource.get(a.sourceId) ?? [];
		const indexA = list.findIndex((candidate) => candidate.chunkId === a.chunkId);
		const indexB = list.findIndex((candidate) => candidate.chunkId === b.chunkId);
		return indexA >= 0 && indexB >= 0 && Math.abs(indexA - indexB) === 1;
	}

	// 关键词共现边：仅当两端不是同源相邻时才生成，避免与 sequential 重复表达
	for (const chunk of chunks) {
		const neighbors = new Map<string, number>();
		for (const keyword of chunk.keywords) {
			for (const neighborId of keywordToChunks.get(keyword) ?? []) {
				if (neighborId === chunk.chunkId) {
					continue;
				}
				neighbors.set(neighborId, (neighbors.get(neighborId) ?? 0) + 1);
			}
		}
		for (const [neighborId, overlap] of neighbors) {
			const neighbor = chunks.find((candidate) => candidate.chunkId === neighborId);
			if (!neighbor || neighbor.keywords.length === 0) {
				continue;
			}
			if (areSequential(chunk, neighbor)) {
				continue;
			}
			const weight = overlap / Math.min(chunk.keywords.length, neighbor.keywords.length);
			if (weight >= 0.15) {
				addEdge(chunk.chunkId, neighborId, weight, 'keyword-overlap');
			}
		}
	}

	// 同一课件顺序/相邻边
	for (const list of bySource.values()) {
		for (let i = 0; i < list.length; i++) {
			if (i > 0) {
				addEdge(list[i - 1].chunkId, list[i].chunkId, 0.5, 'sequential');
			}
			for (let j = i + 2; j < list.length; j++) {
				addEdge(list[i].chunkId, list[j].chunkId, 0.3, 'same-source');
			}
		}
	}

	return {
		version: 1,
		updatedAt: Date.now(),
		nodes: chunks,
		edges,
	};
}

export function mergeGraphs(base: CoursewareGraph, incoming: CoursewareGraph): CoursewareGraph {
	const existingIds = new Set(base.nodes.map((node) => node.chunkId));
	const newNodes = incoming.nodes.filter((node) => !existingIds.has(node.chunkId));
	return {
		version: base.version + 1,
		updatedAt: Date.now(),
		nodes: [...base.nodes, ...newNodes],
		edges: [...base.edges, ...incoming.edges],
	};
}
