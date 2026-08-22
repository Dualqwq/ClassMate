import * as vscode from 'vscode';
import type { CoursewareExtensionToWebviewMessage, CoursewareWebviewToExtensionMessage } from '../courseware/types';
import { CoursewareService } from '../courseware/coursewareService';
import { getCoursewareWebviewHtml } from '../courseware/webview/getCoursewareWebviewHtml';
import { registerClassMatePanel, resolveNewPanelColumn } from './panelGrouping';

export class CoursewarePanel {
	public static readonly viewType = 'classmate.coursewarePanel';
	private static _currentPanel: CoursewarePanel | undefined;

	private readonly _panel: vscode.WebviewPanel;
	private readonly _extensionUri: vscode.Uri;
	private readonly _service: CoursewareService;
	private readonly _disposables: vscode.Disposable[] = [];
	private _isDisposed = false;

	public static createOrShow(
		extensionUri: vscode.Uri,
		service: CoursewareService,
		options?: { preserveFocus?: boolean }
	): CoursewarePanel {
		const activeEditor = vscode.window.activeTextEditor;
		const visibleEditors = vscode.window.visibleTextEditors;
		const activeColumn = activeEditor?.viewColumn;

		if (CoursewarePanel._currentPanel) {
			CoursewarePanel._currentPanel._panel.reveal(activeColumn, options?.preserveFocus ?? false);
			return CoursewarePanel._currentPanel;
		}

		const targetColumn = resolveNewPanelColumn(visibleEditors.length, activeColumn);
		const panel = vscode.window.createWebviewPanel(
			CoursewarePanel.viewType,
			'ClassMate 课件管理',
			{ viewColumn: targetColumn, preserveFocus: options?.preserveFocus ?? false },
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist')],
			}
		);

		CoursewarePanel._currentPanel = new CoursewarePanel(panel, extensionUri, service);
		return CoursewarePanel._currentPanel;
	}

	private constructor(
		panel: vscode.WebviewPanel,
		extensionUri: vscode.Uri,
		service: CoursewareService
	) {
		this._panel = panel;
		this._extensionUri = extensionUri;
		this._service = service;
		this._panel.webview.html = getCoursewareWebviewHtml(this._panel.webview, extensionUri);

		this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
		this._disposables.push(
			registerClassMatePanel({
				viewType: CoursewarePanel.viewType,
				getActiveColumn: () => (this._panel.active ? this._panel.viewColumn : undefined),
			})
		);
		this._panel.webview.onDidReceiveMessage(
			(message: CoursewareWebviewToExtensionMessage) => void this._handleMessage(message),
			null,
			this._disposables
		);
		void this._sendList();
	}

	public postMessage(message: CoursewareExtensionToWebviewMessage): void {
		void this._panel.webview.postMessage(message);
	}

	public dispose(): void {
		if (this._isDisposed) {
			return;
		}
		this._isDisposed = true;
		CoursewarePanel._currentPanel = undefined;
		this._panel.dispose();
		while (this._disposables.length) {
			const x = this._disposables.pop();
			if (x) {
				x.dispose();
			}
		}
	}

	private async _handleMessage(message: CoursewareWebviewToExtensionMessage): Promise<void> {
		switch (message.type) {
			case 'requestList':
				await this._sendList();
				break;
			case 'importPdf':
				await this._importPdf();
				break;
			case 'deleteCourseware':
				await this._deleteCourseware(message.id);
				break;
			case 'rebuildGraph':
				await this._rebuildGraph();
				break;
			case 'testQuery':
				await this._testQuery(message.query);
				break;
			default:
				console.log('Unhandled courseware message:', message);
		}
	}

	private async _sendList(): Promise<void> {
		const items = this._service.items;
		const graph = await this._service.loadGraph();
		this.postMessage({ type: 'list', items, graphStats: { nodes: graph.nodes.length, edges: graph.edges.length, updatedAt: graph.updatedAt } });
	}

	private async _importPdf(): Promise<void> {
		const uris = await vscode.window.showOpenDialog({
			canSelectMany: true,
			openLabel: '导入 PDF',
			filters: { PDF: ['pdf'] },
		});
		if (!uris || uris.length === 0) {
			return;
		}
		for (const uri of uris) {
			this.postMessage({ type: 'importProgress', id: uri.toString(), status: 'parsing' });
			try {
				await this._service.importPdf(uri);
				this.postMessage({ type: 'importProgress', id: uri.toString(), status: 'done' });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				this.postMessage({ type: 'importProgress', id: uri.toString(), status: 'error', message });
			}
		}
		await this._sendList();
	}

	private async _deleteCourseware(id: string): Promise<void> {
		try {
			await this._service.deleteCourseware(id);
			await this._sendList();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.postMessage({ type: 'error', message: `删除失败: ${message}` });
		}
	}

	private async _rebuildGraph(): Promise<void> {
		try {
			const graph = await this._service.rebuildGraphFromItems((progress) => {
				this.postMessage({ type: 'importProgress', id: 'rebuild', status: 'building', message: progress });
			});
			this.postMessage({ type: 'importProgress', id: 'rebuild', status: 'done' });
			this.postMessage({ type: 'graphStats', nodes: graph.nodes.length, edges: graph.edges.length, updatedAt: graph.updatedAt });
			await this._sendList();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.postMessage({ type: 'error', message: `重建失败: ${message}` });
		}
	}

	private async _testQuery(query: string): Promise<void> {
		try {
			const results = await this._service.retrieve(query);
			this.postMessage({ type: 'testQueryResult', query, results });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.postMessage({ type: 'error', message: `检索失败: ${message}` });
		}
	}
}
