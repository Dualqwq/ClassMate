import type { CoursewareEdge, CoursewareGraph, CoursewareRetrievalResult } from './types';

/**
 * 基于查询关键词与图传播进行简单 RAG 检索。
 * 步骤：
 * 1. 关键词匹配得到初始节点；
 * 2. 沿边传播一次（权重衰减），聚合邻居得分；
 * 3. 返回 topK 片段。
 */
export function retrieveCoursewareChunks(
	graph: CoursewareGraph,
	query: string,
	topK = 4
): CoursewareRetrievalResult[] {
	const queryTerms = extractQueryTerms(query);
	if (queryTerms.length === 0 || graph.nodes.length === 0) {
		return [];
	}

	const scores = new Map<string, number>();
	for (const node of graph.nodes) {
		let score = 0;
		for (const term of queryTerms) {
			if (node.keywords.includes(term)) {
				score += 1;
			}
			// 内容中完整出现也计分，但权重较低
			if (node.content.toLowerCase().includes(term)) {
				score += 0.3;
			}
		}
		if (score > 0) {
			scores.set(node.chunkId, score);
		}
	}

	// 图传播一次
	const adjacency = buildAdjacency(graph.edges);
	const propagated = new Map<string, number>(scores);
	for (const [chunkId, score] of scores) {
		const neighbors = adjacency.get(chunkId) ?? [];
		for (const { to, weight } of neighbors) {
			propagated.set(to, (propagated.get(to) ?? 0) + score * weight * 0.4);
		}
	}

	const nodeById = new Map(graph.nodes.map((node) => [node.chunkId, node]));
	return [...propagated.entries()]
		.map(([chunkId, score]): CoursewareRetrievalResult | undefined => {
			const node = nodeById.get(chunkId);
			if (!node) {
				return undefined;
			}
			return {
				chunkId,
				sourceId: node.sourceId,
				fileName: node.fileName,
				pageStart: node.pageStart,
				pageEnd: node.pageEnd,
				content: node.content,
				score,
			};
		})
		.filter((item): item is CoursewareRetrievalResult => item !== undefined)
		.sort((a, b) => b.score - a.score)
		.slice(0, topK);
}

function extractQueryTerms(query: string): string[] {
	const terms = new Set<string>();
	for (const match of query.toLowerCase().matchAll(/[a-z0-9_]{2,24}/g)) {
		terms.add(match[0]);
	}
	const cjk = query.replace(/[^\u4e00-\u9fa5]/g, '');
	for (let i = 0; i < cjk.length - 1; i++) {
		for (let len = 2; len <= 6 && i + len <= cjk.length; len++) {
			terms.add(cjk.slice(i, i + len));
		}
	}
	return [...terms].filter((term) => term.length >= 2);
}

function buildAdjacency(edges: CoursewareEdge[]): Map<string, Array<{ to: string; weight: number }>> {
	const map = new Map<string, Array<{ to: string; weight: number }>>();
	for (const edge of edges) {
		const list = map.get(edge.from) ?? [];
		list.push({ to: edge.to, weight: edge.weight });
		map.set(edge.from, list);
		const reverse = map.get(edge.to) ?? [];
		reverse.push({ to: edge.from, weight: edge.weight });
		map.set(edge.to, reverse);
	}
	return map;
}

/**
 * 把检索结果渲染为 prompt 块。
 */
export function formatRetrievalResults(results: CoursewareRetrievalResult[]): string {
	if (results.length === 0) {
		return '[No matching courseware fragments found.]';
	}
	const lines = ['=== Courseware context (from imported slides/notes) ==='];
	for (const result of results) {
		const pageLabel = result.pageStart === result.pageEnd
			? `p.${result.pageStart}`
			: `p.${result.pageStart}-${result.pageEnd}`;
		lines.push(`\n--- ${result.fileName} (${pageLabel}) ---`);
		lines.push(result.content);
	}
	lines.push('\nUse the above courseware fragments to ground your answer when relevant.');
	return lines.join('\n');
}
