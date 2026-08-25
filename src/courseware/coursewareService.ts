import * as vscode from 'vscode';
import type { CoursewareChunk, CoursewareGraph, CoursewareItem, CoursewareRetrievalResult, CoursewareServiceConfig } from './types';
import { CoursewareStore } from './coursewareStore';
import { extractCoursewareDocument } from './coursewareChunker';
import { buildCoursewareGraph, mergeGraphs } from './graphBuilder';
import { retrieveCoursewareChunks } from './retriever';
import { formatCoursewareContext } from './coursewarePromptInjector';

export class CoursewareService {
	private readonly _store: CoursewareStore;
	private readonly _config: Required<CoursewareServiceConfig>;
	private _graph: CoursewareGraph | undefined;

	constructor(context: vscode.ExtensionContext, config?: CoursewareServiceConfig) {
		this._store = new CoursewareStore(context);
		this._config = {
			storageUri: config?.storageUri ?? context.globalStorageUri,
			maxPdfBytes: config?.maxPdfBytes ?? 20 * 1024 * 1024,
			chunkSize: config?.chunkSize ?? 1200,
			chunkOverlap: config?.chunkOverlap ?? 120,
			topK: config?.topK ?? 4,
		};
	}

	public get items(): CoursewareItem[] {
		return this._store.getItems();
	}

	public getItem(id: string): CoursewareItem | undefined {
		return this._store.getItem(id);
	}

	public async loadGraph(): Promise<CoursewareGraph> {
		if (!this._graph) {
			this._graph = await this._store.loadGraph();
		}
		return this._graph;
	}

	public async importPdf(uri: vscode.Uri): Promise<CoursewareItem> {
		const fileName = uri.path.split('/').pop() ?? uri.toString();
		const sourceId = `file-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
		const { chunks, pageCount } = await extractCoursewareDocument(sourceId, fileName, uri, {
			chunkSize: this._config.chunkSize,
			chunkOverlap: this._config.chunkOverlap,
		});
		const item: CoursewareItem = {
			id: sourceId,
			fileName,
			uri: uri.toString(),
			pageCount,
			chunkCount: chunks.length,
			addedAt: Date.now(),
		};
		await this._store.addItem(item);
		const previousGraph = await this.loadGraph();
		const incoming = buildCoursewareGraph(chunks);
		this._graph = mergeGraphs(previousGraph, incoming);
		if (previousGraph.needsRebuild) {
			// 新导入只把新课件带入图里，旧结构课件仍缺：保留待重建标记，
			// 直到用户点「重建搜索图」按当前列表全量重建。
			this._graph.needsRebuild = true;
		}
		await this._store.saveGraph(this._graph);
		return item;
	}

	public async deleteCourseware(id: string): Promise<void> {
		// 用户拍板语义：删除仅把课件移出导入列表（元数据随 workspaceState 持久化消失），
		// 已构建的搜索图原样保留，直到点「重建搜索图」时按当前列表全量重建。
		await this._store.removeItem(id);
	}

	public async rebuildGraphFromItems(progress?: (message: string) => void): Promise<CoursewareGraph> {
		const items = this._store.getItems();
		let allChunks: CoursewareChunk[] = [];
		for (const item of items) {
			try {
				progress?.(`正在解析: ${item.fileName}`);
				const { chunks } = await extractCoursewareDocument(item.id, item.fileName, vscode.Uri.parse(item.uri), {
					chunkSize: this._config.chunkSize,
					chunkOverlap: this._config.chunkOverlap,
				});
				allChunks = [...allChunks, ...chunks];
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				progress?.(`解析失败 ${item.fileName}: ${message}`);
				console.warn(`[ClassMate courseware] rebuild failed for ${item.fileName}:`, message);
			}
		}
		this._graph = buildCoursewareGraph(allChunks);
		await this._store.saveGraph(this._graph);
		return this._graph;
	}

	public async retrieve(query: string, topK?: number): Promise<CoursewareRetrievalResult[]> {
		const graph = await this.loadGraph();
		return retrieveCoursewareChunks(graph, query, topK ?? this._config.topK);
	}

	/**
	 * 检索并按注入层形态格式化（D8：定位头 + 预算，空命中返回 ''）。
	 * @param previousUserText 多轮对话时传入上一轮提问（开放问题 §4.1② 拍板：
	 * query 并入上一轮 userText 再检索，缓解指代省略导致的检索漂移）。
	 */
	public async retrieveFormatted(query: string, topK?: number, previousUserText?: string): Promise<string> {
		const merged = previousUserText?.trim() ? `${previousUserText.trim()}\n${query}` : query;
		return formatCoursewareContext(await this.retrieve(merged, topK));
	}
}
