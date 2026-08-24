import * as vscode from 'vscode';
import type { CoursewareExtensionToWebviewMessage, CoursewareWebviewToExtensionMessage } from '../courseware/types';
import { CoursewareService } from '../courseware/coursewareService';
import { openCoursewareChunkSource, showCoursewareSourceOutcome } from '../courseware/coursewareSourceOpener';
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
			case 'openCoursewareSource':
				this._openCoursewareSource(message.chunkId);
				break;
			default:
				console.log('Unhandled courseware message:', message);
		}
	}

	private async _sendList(): Promise<void> {
		const items = this._service.items;
		const graph = await this._service.loadGraph();
		this.postMessage({
			type: 'list',
			items,
			graphStats: {
				nodes: graph.nodes.length,
				edges: graph.edges.length,
				updatedAt: graph.updatedAt,
				needsRebuild: graph.needsRebuild === true,
			},
		});
	}

	private async _importPdf(): Promise<void> {
		const uris = await vscode.window.showOpenDialog({
			canSelectMany: true,
			openLabel: '导入课件',
			filters: { 'PDF / PPTX': ['pdf', 'pptx'] },
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
		const item = this._service.items.find((candidate) => candidate.id === id);
		try {
			// 确认走扩展宿主的原生模态框:webview iframe 里 window.confirm 被静默禁用,
			// 依赖它会导致删除按钮看起来点了没反应。
			const label = item?.fileName ?? id;
			const pick = await vscode.window.showWarningMessage(
				`确定从课件列表移除「${label}」？已构建的搜索图不会改变，直到点击「重建搜索图」。`,
				{ modal: true },
				'移除'
			);
			if (pick !== '移除') {
				return;
			}
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
			// 空列表重建产出空图:带 message 让管理页显示明确状态而不是静默清空进度。
			const doneMessage = graph.nodes.length === 0
				? '导入列表为空，已重建出空搜索图'
				: undefined;
			this.postMessage({ type: 'importProgress', id: 'rebuild', status: 'done', message: doneMessage });
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

	private async _openCoursewareSource(chunkId: string): Promise<void> {
		showCoursewareSourceOutcome(await openCoursewareChunkSource(this._service, chunkId));
	}
}
