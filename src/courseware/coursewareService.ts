import * as vscode from 'vscode';
import type { CoursewareGraph, CoursewareItem, CoursewareRetrievalResult, CoursewareServiceConfig } from './types';
import { CoursewareStore } from './coursewareStore';
import { extractAndChunkCourseware } from './coursewareChunker';
import { buildCoursewareGraph, mergeGraphs } from './graphBuilder';
import { formatRetrievalResults, retrieveCoursewareChunks } from './retriever';

export { formatRetrievalResults };

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

	public async loadGraph(): Promise<CoursewareGraph> {
		if (!this._graph) {
			this._graph = await this._store.loadGraph();
		}
		return this._graph;
	}

	public async importPdf(uri: vscode.Uri): Promise<CoursewareItem> {
		const fileName = uri.path.split('/').pop() ?? uri.toString();
		const sourceId = `file-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
		const chunks = await extractAndChunkCourseware(sourceId, fileName, uri, {
			chunkSize: this._config.chunkSize,
			chunkOverlap: this._config.chunkOverlap,
		});
		const pageCount = chunks.length > 0 ? chunks[chunks.length - 1].pageEnd : 0;
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
		let allChunks: Awaited<ReturnType<typeof extractAndChunkCourseware>> = [];
		for (const item of items) {
			try {
				progress?.(`正在解析: ${item.fileName}`);
				const chunks = await extractAndChunkCourseware(item.id, item.fileName, vscode.Uri.parse(item.uri), {
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

	public async retrieveFormatted(query: string, topK?: number): Promise<string> {
		return formatRetrievalResults(await this.retrieve(query, topK));
	}
}
