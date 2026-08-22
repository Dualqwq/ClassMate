import * as vscode from 'vscode';
import type { CoursewareGraph, CoursewareItem } from './types';

const ITEMS_KEY = 'classmate.courseware.items';

/**
 * 课件元数据与图持久化。
 * - 元数据存 workspaceState（跟随工作区）；
 * - 抽取的图存 globalStorageUri/classmate-courseware/<workspaceId>/graph.json，不污染学生工作区。
 */
export class CoursewareStore {
	private readonly _context: vscode.ExtensionContext;
	private readonly _items: Map<string, CoursewareItem> = new Map();

	constructor(context: vscode.ExtensionContext) {
		this._context = context;
		const persisted = context.workspaceState.get<CoursewareItem[]>(ITEMS_KEY, []);
		for (const item of persisted) {
			this._items.set(item.id, item);
		}
	}

	public getItems(): CoursewareItem[] {
		return [...this._items.values()].sort((a, b) => b.addedAt - a.addedAt);
	}

	public getItem(id: string): CoursewareItem | undefined {
		return this._items.get(id);
	}

	public async addItem(item: CoursewareItem): Promise<void> {
		this._items.set(item.id, item);
		await this._persistItems();
	}

	public async removeItem(id: string): Promise<void> {
		this._items.delete(id);
		await this._persistItems();
	}

	public async clear(): Promise<void> {
		this._items.clear();
		await this._persistItems();
		await this.saveGraph({ version: 0, updatedAt: Date.now(), nodes: [], edges: [] });
	}

	public async saveGraph(graph: CoursewareGraph): Promise<void> {
		const uri = this._graphUri();
		await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
		await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(graph), 'utf8'));
	}

	public async loadGraph(): Promise<CoursewareGraph> {
		const uri = this._graphUri();
		try {
			const bytes = await vscode.workspace.fs.readFile(uri);
			const parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
			if (parsed && Array.isArray(parsed.nodes) && Array.isArray(parsed.edges)) {
				return parsed as CoursewareGraph;
			}
		} catch {
			// 文件不存在或损坏时返回空图
		}
		return { version: 0, updatedAt: Date.now(), nodes: [], edges: [] };
	}

	private async _persistItems(): Promise<void> {
		await this._context.workspaceState.update(ITEMS_KEY, this.getItems());
	}

	private _graphUri(): vscode.Uri {
		const workspaceId = this._workspaceId();
		return vscode.Uri.joinPath(
			this._context.globalStorageUri,
			'classmate-courseware',
			workspaceId,
			'graph.json'
		);
	}

	private _workspaceId(): string {
		const folders = vscode.workspace.workspaceFolders;
		if (!folders || folders.length === 0) {
			return 'no-workspace';
		}
		return folders[0].uri.toString().replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
	}
}
