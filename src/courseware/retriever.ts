import type { CoursewareEdge, CoursewareGraph, CoursewareRetrievalResult } from './types';
import { extractQueryTerms } from './tokenizer';

/** 内容命中计分次数上限：出现更多次不再加分，避免长 chunk 垄断排序。 */
const MAX_CONTENT_HITS_SCORED = 5;

/**
 * top-k 按来源课件分散（D6）：单个课件最多占 ⌈topK/2⌉ 席，
 * 仅当其他课件的候选耗尽时才允许超额补位。
 */
function maxPerSource(topK: number): number {
	return Math.max(1, Math.ceil(topK / 2));
}

/**
 * 贪心分散选择：按分数降序遍历候选；某课件已占满 ⌈topK/2⌉ 席时先跳过，
 * 若直到末尾仍凑不满 topK 再允许超额课件回填补位（保证小图不缺结果）。
 */
function selectDispersedTopK(
	candidates: CoursewareRetrievalResult[],
	topK: number
): CoursewareRetrievalResult[] {
	const cap = maxPerSource(topK);
	const perSource = new Map<string, number>();
	const picked: CoursewareRetrievalResult[] = [];
	const deferred: CoursewareRetrievalResult[] = [];
	for (const candidate of candidates) {
		if (picked.length >= topK) {
			break;
		}
		const count = perSource.get(candidate.sourceId) ?? 0;
		if (count >= cap) {
			deferred.push(candidate);
			continue;
		}
		perSource.set(candidate.sourceId, count + 1);
		picked.push(candidate);
	}
	for (const candidate of deferred) {
		if (picked.length >= topK) {
			break;
		}
		picked.push(candidate);
	}
	return picked;
}

/**
 * 基于查询关键词与图传播进行简单 RAG 检索。
 * 步骤：
 * 1. 查询侧统一分词（与索引侧同一套 tokenizer，含中英别名扩展，D7）；
 * 2. 关键词匹配得到初始节点；
 * 3. 沿边传播一次（权重衰减）聚合邻居得分；same-source 边不参与传播
 *    （D6：退出排序评分、仅保留遍历用途，top-4 同课件扎堆的根源）；
 * 4. 排序后按来源课件分散取 topK。
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
		const lowerContent = node.content.toLowerCase();
		for (const term of queryTerms) {
			if (node.keywords.includes(term)) {
				score += 1;
			}
			// 内容中出现次数越多得分越高（封顶，避免长文垄断），
			// 同时让「树」「图」这类单字 CJK 查询能按密度区分相关性。
			const occurrences = countOccurrences(lowerContent, term);
			if (occurrences > 0) {
				score += Math.min(occurrences, MAX_CONTENT_HITS_SCORED) * 0.3;
			}
		}
		if (score > 0) {
			scores.set(node.chunkId, score);
		}
	}

	// 图传播一次（same-source 边退出评分）
	const adjacency = buildAdjacency(graph.edges);
	const propagated = new Map<string, number>(scores);
	for (const [chunkId, score] of scores) {
		const neighbors = adjacency.get(chunkId) ?? [];
		for (const { to, weight } of neighbors) {
			propagated.set(to, (propagated.get(to) ?? 0) + score * weight * 0.4);
		}
	}

	const nodeById = new Map(graph.nodes.map((node) => [node.chunkId, node]));
	const ranked = [...propagated.entries()]
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
				// 可选定位信息透传（打分语义不变），供管理页结果列表展示 title/slide。
				title: node.title,
				unitLabel: node.unitLabel,
			};
		})
		.filter((item): item is CoursewareRetrievalResult => item !== undefined)
		.sort((a, b) => b.score - a.score);
	if (ranked.length <= topK) {
		return ranked;
	}
	return selectDispersedTopK(ranked, topK);
}

function countOccurrences(haystack: string, needle: string): number {
	if (!needle) {
		return 0;
	}
	let count = 0;
	let index = haystack.indexOf(needle);
	while (index !== -1) {
		count++;
		index = haystack.indexOf(needle, index + needle.length);
	}
	return count;
}

function buildAdjacency(edges: CoursewareEdge[]): Map<string, Array<{ to: string; weight: number }>> {
	const map = new Map<string, Array<{ to: string; weight: number }>>();
	for (const edge of edges) {
		// D6：same-source 边仅保留遍历用途，不参与排序传播
		if (edge.reason === 'same-source') {
			continue;
		}
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
 * 把检索结果渲染为 prompt 块（管理页调试等旧路径仍用；
 * 注入给模型的形态由 coursewarePromptInjector 统一实现预算与定位头）。
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
