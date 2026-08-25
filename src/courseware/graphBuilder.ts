import { COURSEWARE_GRAPH_VERSION, type CoursewareChunk, type CoursewareEdge, type CoursewareGraph } from './types';
import { extractWeightedKeywords } from './tokenizer';

/**
 * 基于 chunk 关键词共现构建轻量 GraphRAG 图（期 2 检索层 D6/D7：类型化实体关系边）。
 * 边类型：
 * - mentions：跨源 chunk 共享关键词；权重=共享数/min(关键词数)。
 * - defines：定义块锚定——某 chunk 以「X 是指/定义为/X is a …」定义术语 X，
 *   其他 chunk 提及 X 时建立 defines 边（正则锚定，术语限定在分词结果内）。
 * - belongs_to：chunk 与其来源课件的 TOC 摘要节点之间的从属关系。
 * - precedes：同一课件内相邻 chunk 的先后关系；权重=0.5。
 * - same-source：同一课件内非相邻 chunk；权重=0.3，检索排序传播时跳过
 *   （top-4 同课件扎堆的根源，退出评分、仅保留遍历用途）。
 */

/** TOC 摘要节点的固定 chunkId 后缀。 */
export const TOC_CHUNK_ID_SUFFIX = '#toc';

/** 定义模式正则锚定：中文「X 是指/指的是/定义为」「定义：X」与英文「X is a/an/the …」。 */
const DEFINITION_PATTERNS: RegExp[] = [
	/([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9]{0,15}?)(?:是指|指的是|定义为)/g,
	/定义[:：]\s*([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9]{0,15})/g,
	/\b([A-Za-z][A-Za-z0-9 ]{1,29}?)\s+is\s+(?:a|an|the)\b/gi,
];

/** 单 chunk 最多产出的 defines 边数，防异常语料爆边。 */
const MAX_DEFINES_EDGES_PER_CHUNK = 4;

export function buildCoursewareGraph(inputChunks: CoursewareChunk[]): CoursewareGraph {
	// 不改调用方数组：TOC 摘要节点只追加在内部副本上。
	const chunks = [...inputChunks];
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

	// 关键词共现边（mentions）：仅当两端不是同源相邻时才生成，避免与 precedes 重复表达
	for (const chunk of chunks) {
		const neighbors = new Map<string, number>();
		for (const keyword of chunk.keywords) {
			for (const neighborId of keywordToChunks.get(keyword) ?? []) {
				if (neighborId === chunk.chunkId || neighborId.endsWith(TOC_CHUNK_ID_SUFFIX)) {
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
				addEdge(chunk.chunkId, neighborId, weight, 'mentions');
			}
		}
	}

	// 同一课件顺序/相邻边（precedes）与非相邻 same-source 边（仅遍历）
	for (const list of bySource.values()) {
		for (let i = 0; i < list.length; i++) {
			if (i > 0) {
				addEdge(list[i - 1].chunkId, list[i].chunkId, 0.5, 'precedes');
			}
			for (let j = i + 2; j < list.length; j++) {
				addEdge(list[i].chunkId, list[j].chunkId, 0.3, 'same-source');
			}
		}
	}

	// 定义模式锚定的 defines 边：定义块 → 提及该术语的其他 chunk
	buildDefinesEdges(chunks, addEdge);

	// TOC 摘要节点 + belongs_to 从属边（最小版：每课件一个目录节点）
	for (const [sourceId, list] of bySource) {
		if (list.length < 3) {
			// 过短课件目录无增量信息，不建摘要节点
			continue;
		}
		const tocNode = buildTocNode(sourceId, list);
		chunks.push(tocNode);
		for (const chunk of list) {
			addEdge(chunk.chunkId, tocNode.chunkId, 0.4, 'belongs_to');
		}
	}

	return {
		version: COURSEWARE_GRAPH_VERSION,
		updatedAt: Date.now(),
		nodes: chunks,
		edges,
	};
}

/** 抽取一个 chunk 中被「定义」的术语（限定为该 chunk 关键词或分词词表内的真词）。 */
export function extractDefinedTerms(content: string, keywords: string[]): string[] {
	const candidates = new Set<string>();
	for (const pattern of DEFINITION_PATTERNS) {
		pattern.lastIndex = 0;
		for (const match of content.matchAll(pattern)) {
			const raw = (match[1] ?? '').trim();
			if (raw) {
				candidates.add(raw.toLowerCase());
			}
		}
	}
	const keywordSet = new Set(keywords);
	const defined: string[] = [];
	for (const candidate of candidates) {
		// 锚定：候选必须命中关键词集（封闭锚点起步），避免自由抽取产生噪声实体。
		if (keywordSet.has(candidate) && !defined.includes(candidate)) {
			defined.push(candidate);
		}
		if (defined.length >= MAX_DEFINES_EDGES_PER_CHUNK) {
			break;
		}
	}
	return defined;
}

function buildDefinesEdges(
	chunks: CoursewareChunk[],
	addEdge: (from: string, to: string, weight: number, reason: CoursewareEdge['reason']) => void
): void {
	for (const definer of chunks) {
		if (definer.chunkId.endsWith(TOC_CHUNK_ID_SUFFIX)) {
			continue;
		}
		let added = 0;
		for (const term of extractDefinedTerms(definer.content, definer.keywords)) {
			for (const other of chunks) {
				if (other === definer || added >= MAX_DEFINES_EDGES_PER_CHUNK) {
					continue;
				}
				const mentions = other.keywords.includes(term)
					|| other.content.toLowerCase().includes(term);
				if (mentions && !other.chunkId.endsWith(TOC_CHUNK_ID_SUFFIX)) {
					addEdge(definer.chunkId, other.chunkId, 0.6, 'defines');
					added++;
				}
			}
		}
	}
}

/** TOC 摘要节点：按顺序列出单元标签与标题，关键词取标题加权。 */
function buildTocNode(sourceId: string, list: CoursewareChunk[]): CoursewareChunk {
	const fileName = list[0].fileName;
	const lines = list.map((chunk) => {
		const title = chunk.title ? ` ${chunk.title}` : '';
		return `${chunk.unitLabel ?? `p.${chunk.pageStart}`}${title}`;
	});
	const content = ['目录', ...lines].join('\n');
	return {
		chunkId: `${sourceId}${TOC_CHUNK_ID_SUFFIX}`,
		sourceId,
		fileName,
		pageStart: 0,
		pageEnd: 0,
		content,
		keywords: extractWeightedKeywords('目录', lines.join('\n')),
		title: '目录',
		unitLabel: '目录',
	};
}

export function mergeGraphs(base: CoursewareGraph, incoming: CoursewareGraph): CoursewareGraph {
	const existingIds = new Set(base.nodes.map((node) => node.chunkId));
	const newNodes = incoming.nodes.filter((node) => !existingIds.has(node.chunkId));
	return {
		// 取两侧较高版本：空图(v0)并入新图(v3)时结果仍是当前结构版本，
		// 否则会回落成旧版本而在下次加载时被误判为待重建。
		version: Math.max(base.version, incoming.version),
		updatedAt: Date.now(),
		nodes: [...base.nodes, ...newNodes],
		edges: [...base.edges, ...incoming.edges],
	};
}
