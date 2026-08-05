import * as vscode from 'vscode';
import type { DebugJourneyNode } from '../debug/debugJourneyTreeNodes';
import { buildDebugJourneyNodes } from '../debug/debugJourneyTreeNodes';
import { filterEventsToExistingFiles } from '../debug/debugJourneyFileFilter';
import type { DebugJourneyStore } from '../debug/debugJourneyStore';

/**
 * 默认存在性判断:只对 `file:` 方案的 URI 做磁盘检查。
 * 非 `file:` 方案(untitled/output 等)或解析失败的 URI 一律视为存在,
 * 避免把无法判断的记录从树里误删。
 */
async function fileExistsOnDisk(fileUri: string): Promise<boolean> {
	try {
		const uri = vscode.Uri.parse(fileUri);
		if (uri.scheme !== 'file') {
			return true;
		}
		await vscode.workspace.fs.stat(uri);
		return true;
	} catch {
		return false;
	}
}

export class DebugJourneyTreeProvider implements vscode.TreeDataProvider<DebugJourneyNode> {
    public static readonly viewType = 'classmate.debugJourneyTree';

    private readonly _onDidChangeTreeData = new vscode.EventEmitter<DebugJourneyNode | undefined>();
    public readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private readonly _store: DebugJourneyStore;
    private _rootNodes: DebugJourneyNode[] = [];

    constructor(store: DebugJourneyStore) {
        this._store = store;
        // Eagerly load so the collapsed Debug Journey view below ChatView already
        // has data the moment the sidebar becomes visible.
        void this.load();
    }

    public async load(): Promise<void> {
        const events = await this._store.getEvents();
        // 只过滤树的显示,store 里的原始隐式日志保持不变。
        this._rootNodes = buildDebugJourneyNodes(await filterEventsToExistingFiles(events, fileExistsOnDisk));
        this._onDidChangeTreeData.fire(undefined);
    }

    public refresh(): void {
        void this.load();
    }

    public getTreeItem(element: DebugJourneyNode): vscode.TreeItem {
        const item = new vscode.TreeItem(element.label, element.collapsibleState);
        item.description = element.description;
        item.tooltip = element.tooltip;
        item.iconPath = element.iconPath;
        item.contextValue = element.contextValue;
        item.command = element.command;
        item.id = element.id;
        return item;
    }

    public getChildren(element?: DebugJourneyNode): DebugJourneyNode[] {
        if (!element) {
            return this._rootNodes;
        }
        return element.children;
    }

    public getParent(_element: DebugJourneyNode): DebugJourneyNode | undefined {
        // Optional: VS Code uses this for reveal(). Returning undefined is acceptable for now.
        return undefined;
    }

    /**
     * Expose the current root nodes so callers can search the tree without
     * reloading from the store.
     */
    public getRootNodes(): DebugJourneyNode[] {
        return this._rootNodes;
    }
}
