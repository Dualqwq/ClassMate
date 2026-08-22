import type * as vscode from 'vscode';

/**
 * 单个课件（目前仅 PDF）的元数据。
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
	/** 用于简单关键词检索/建边的关键词。 */
	keywords: string[];
}

/**
 * 两个 chunk 之间的边：基于关键词共现或显式引用。
 */
export interface CoursewareEdge {
	from: string;
	to: string;
	weight: number;
	reason: 'keyword-overlap' | 'same-source' | 'sequential';
}

/**
 * 课件知识图：节点=chunk，边=关系。
 */
export interface CoursewareGraph {
	version: number;
	updatedAt: number;
	nodes: CoursewareChunk[];
	edges: CoursewareEdge[];
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
}

/**
 * CoursewareService 的统一配置。
 */
export interface CoursewareServiceConfig {
	storageUri: vscode.Uri;
	/**
	 * 导入时单个 PDF 的最大字节数；与 pdfExtractor 保持一致。
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
	| { type: 'testQuery'; query: string };

export type CoursewareExtensionToWebviewMessage =
	| { type: 'list'; items: CoursewareItem[]; graphStats: { nodes: number; edges: number; updatedAt?: number } }
	| { type: 'importProgress'; id: string; status: 'parsing' | 'chunking' | 'building' | 'done' | 'error'; message?: string }
	| { type: 'graphStats'; nodes: number; edges: number; updatedAt?: number }
	| { type: 'testQueryResult'; query: string; results: CoursewareRetrievalResult[] }
	| { type: 'error'; message: string };
