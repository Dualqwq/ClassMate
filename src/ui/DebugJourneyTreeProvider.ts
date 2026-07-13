import * as vscode from 'vscode';
import type { DebugJourneyNode } from '../debug/debugJourneyTreeNodes';
import { buildDebugJourneyNodes } from '../debug/debugJourneyTreeNodes';
import type { DebugJourneyStore } from '../debug/debugJourneyStore';

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
        this._rootNodes = buildDebugJourneyNodes(events);
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
