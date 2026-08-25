import type * as vscode from 'vscode';

/**
 * 当前课件图结构版本。
 * version 3：类型化实体关系边（mentions/defines/belongs_to/precedes）+ TOC 摘要节点 +
 * 查询侧统一分词。version≤2 的旧图在加载时被丢弃并提示手动重建。
 */
export const COURSEWARE_GRAPH_VERSION = 3;

/**
 * 单个课件的元数据。
 */
export interface CoursewareItem {
	id: string;
	fileName: string;
	uri: string;
	pageCount: number;
	chunkCount: number;
	addedAt: number;
}

/**
 * 从课件中提取出的文本块，同时作为 GraphRAG 的节点。
 */
export interface CoursewareChunk {
	chunkId: string;
	sourceId: string;
	fileName: string;
	pageStart: number;
	pageEnd: number;
	content: string;
	/** 用于简单关键词检索/建边的关键词（标题词×3 + 正文词×1 加权取 top-N）。 */
	keywords: string[];
	/** 所在单元的标题（如 slide 标题）；PDF 页暂无可靠标题时缺省。 */
	title?: string;
	/** 所在单元的展示标签，如 "p.12" / "slide 12"。 */
	unitLabel?: string;
	/** 预留：章节路径，待 TOC 摘要层落地时填充。 */
	sectionPath?: string[];
}

/**
 * 两个 chunk 之间的边。
 * version 3 类型化边（D6）：
 * - mentions：跨源 chunk 共享关键词（原 keyword-overlap）；权重=共享数/min(关键词数)。
 * - defines：定义块锚定的「定义→被引用」关系（正则锚定术语表内术语）。
 * - belongs_to：chunk 与其来源课件的 TOC 摘要节点之间的从属关系。
 * - precedes：同一课件内相邻 chunk 的先后关系（原 sequential）。
 * - same-source：同一课件内非相邻 chunk；不参与排序传播（仅保留遍历用途）。
 * keyword-overlap / sequential 为 version≤2 旧图的遗留类型字面量，仅为兼容旧数据保留。
 */
export interface CoursewareEdge {
	from: string;
	to: string;
	weight: number;
	reason:
		| 'mentions'
		| 'defines'
		| 'belongs_to'
		| 'precedes'
		| 'same-source'
		// v2 遗留类型：旧图加载时整体丢弃，但持久化 JSON 反序列化仍需能表达。
		| 'keyword-overlap'
		| 'sequential';
}

/**
 * 课件知识图：节点=chunk，边=关系。
 */
export interface CoursewareGraph {
	version: number;
	updatedAt: number;
	nodes: CoursewareChunk[];
	edges: CoursewareEdge[];
	/**
	 * 读入 version<COURSEWARE_GRAPH_VERSION 的旧结构图时置 true：
	 * 旧图被丢弃返回空图（用户拍板不自动重建，源文件可能已删），
	 * UI 据此提示「请重建搜索图」。
	 */
	needsRebuild?: boolean;
}

/**
 * 检索结果片段，拼入 prompt。
 */
export interface CoursewareRetrievalResult {
	chunkId: string;
	sourceId: string;
	fileName: string;
	pageStart: number;
	pageEnd: number;
	content: string;
	score: number;
	/** 与来源 chunk 对齐的可选定位信息（向后兼容，旧节点缺省）。 */
	title?: string;
	unitLabel?: string;
}

/**
 * CoursewareService 的统一配置。
 */
export interface CoursewareServiceConfig {
	storageUri: vscode.Uri;
	/**
	 * 导入时单个课件文件（PDF/PPTX）的最大字节数。
	 * @default 20MB
	 */
	maxPdfBytes?: number;
	/**
	 * 每个 chunk 的最大字符数。
	 * @default 1200
	 */
	chunkSize?: number;
	/**
	 * chunk 之间的重叠字符数。
	 * @default 120
	 */
	chunkOverlap?: number;
	/**
	 * 检索时返回的最大片段数。
	 * @default 4
	 */
	topK?: number;
}

/**
 * 课件管理页 ↔ 扩展宿主的消息协议。
 */
export type CoursewareWebviewToExtensionMessage =
	| { type: 'requestList' }
	| { type: 'importPdf' }
	| { type: 'deleteCourseware'; id: string }
	| { type: 'rebuildGraph' }
	| { type: 'testQuery'; query: string }
	/** 溯源打开（期 1.5）：点击检索结果链接，用系统默认程序打开原始课件。 */
	| { type: 'openCoursewareSource'; chunkId: string };

export type CoursewareExtensionToWebviewMessage =
	| { type: 'list'; items: CoursewareItem[]; graphStats: { nodes: number; edges: number; updatedAt?: number; needsRebuild?: boolean } }
	| { type: 'importProgress'; id: string; status: 'parsing' | 'chunking' | 'building' | 'done' | 'error'; message?: string }
	| { type: 'graphStats'; nodes: number; edges: number; updatedAt?: number }
	| { type: 'testQueryResult'; query: string; results: CoursewareRetrievalResult[] }
	| { type: 'error'; message: string };
