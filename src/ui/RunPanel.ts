import * as vscode from 'vscode';
import { getRunWebviewHtml } from './getRunWebviewHtml';
import { registerClassMatePanel, resolveNewPanelColumn, resolveRelocationTarget } from './panelGrouping';
import { COMPILE_OUTPUT_SCHEME } from '../compiler/outputPanel';
import type { RunService } from '../run/runService';

/**
 * Run 面板(#11):与 Chat Panel 同级的大标签页 WebviewPanel,常驻
 * (retainContextWhenHidden),关闭后重开历史仍在(StorageUri 持久化)。
 *
 * 分组/闪屏策略完全复用 B1 的 panelGrouping 机制:
 * - 创建时按 resolveNewPanelColumn 落列(不盖住正在看的源码;
 *   active 是 compile_result.txt 时与其同分组);
 * - 创建即登记 registerClassMatePanel,dispose 注销——此后
 *   showTextDocumentRespectingPanels 的 ADD2 预路由对本面板同样生效;
 * - 外部打开(Explorer 点击等)落进面板组时,与 ChatPanel 相同的
 *   relocation 兜底把文件挪去对侧列。
 */
export class RunPanel {
	public static readonly viewType = 'classmate.runPanel';
	private static _currentPanel: RunPanel | undefined;

	private readonly _panel: vscode.WebviewPanel;
	private readonly _runService: RunService;
	private _disposables: vscode.Disposable[] = [];
	/** 面板是否为 active 标签(打开新文件前),由 viewState 与 tab 事件共同维护。 */
	private _panelWasActive = false;
	private _relocating = false;
	private _inactiveTimeout: ReturnType<typeof setTimeout> | undefined;
	private _isDisposed = false;

	public static createOrShow(
		extensionUri: vscode.Uri,
		runService: RunService,
		options?: { preserveFocus?: boolean }
	): RunPanel {
		const activeEditor = vscode.window.activeTextEditor;
		const visibleEditors = vscode.window.visibleTextEditors;
		const activeColumn = activeEditor?.viewColumn;

		if (RunPanel._currentPanel) {
			RunPanel._currentPanel._panel.reveal(activeColumn, options?.preserveFocus ?? false);
			return RunPanel._currentPanel;
		}

		const targetColumn = resolveNewPanelColumn(visibleEditors.length, activeColumn, {
			// active 是 compile_result.txt(classmate-output: 虚拟文档)时,
			// 面板与它同分组打开(同为 ClassMate 面板面,不当源码避让)。
			activeEditorIsClassMateOutput:
				activeEditor?.document.uri.scheme === COMPILE_OUTPUT_SCHEME,
		});

		const panel = vscode.window.createWebviewPanel(
			RunPanel.viewType,
			'ClassMate Run',
			{ viewColumn: targetColumn, preserveFocus: options?.preserveFocus ?? false },
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist')],
			}
		);

		RunPanel._currentPanel = new RunPanel(panel, extensionUri, runService);
		return RunPanel._currentPanel;
	}

	public static hasCurrent(): boolean {
		return RunPanel._currentPanel !== undefined;
	}

	public static revealCurrent(preserveFocus?: boolean): void {
		RunPanel._currentPanel?._panel.reveal(undefined, preserveFocus ?? false);
	}

	private constructor(
		panel: vscode.WebviewPanel,
		extensionUri: vscode.Uri,
		runService: RunService
	) {
		this._panel = panel;
		this._runService = runService;
		this._panelWasActive = panel.active;

		this._panel.webview.html = getRunWebviewHtml(this._panel.webview, extensionUri);

		this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
		this._panel.onDidChangeViewState(
			(event) => this._updatePanelActive(event.webviewPanel.active),
			null,
			this._disposables
		);
		this._disposables.push(
			vscode.window.tabGroups.onDidChangeTabs((event) => this._handleTabChange(event))
		);
		// 登记到 ClassMate 面板注册表(见 ui/panelGrouping.ts):ADD2 分组决策
		// 以"任一已登记面板的 active 列"为准,Run Panel 与 Chat Panel 平权参与。
		this._disposables.push(
			registerClassMatePanel({
				viewType: RunPanel.viewType,
				getActiveColumn: () => (this._panel.active ? this._panel.viewColumn : undefined),
			})
		);
		this._panel.webview.onDidReceiveMessage(
			(message) => void this._runService.handleMessage(message),
			null,
			this._disposables
		);
		this._runService.attach(this);
	}

	public postMessage(message: unknown): void {
		void this._panel.webview.postMessage(message);
	}

	public dispose(): void {
		if (this._isDisposed) {
			return;
		}
		this._isDisposed = true;
		RunPanel._currentPanel = undefined;
		this._runService.detach();
		this._panel.dispose();
		while (this._disposables.length) {
			const x = this._disposables.pop();
			if (x) {
				x.dispose();
			}
		}
	}

	/**
	 * 新文本文件开进面板所在组时的处理(与 ChatPanel 同一兜底):
	 * 仅在面板是打开前的 active 标签时,把新文件挪到对侧分屏。
	 */
	private _handleTabChange(event: vscode.TabChangeEvent): void {
		if (this._relocating) {
			return;
		}
		const panelColumn = this._panel.viewColumn;
		if (panelColumn === undefined || !this._panelWasActive) {
			return;
		}
		const openedTextTab = event.opened.find(
			(tab) => tab.input instanceof vscode.TabInputText && tab.group.viewColumn === panelColumn
		);
		if (!openedTextTab || !(openedTextTab.input instanceof vscode.TabInputText)) {
			return;
		}
		this._relocating = true;
		void this._relocate(openedTextTab, panelColumn).finally(() => {
			this._relocating = false;
		});
	}

	private async _relocate(
		openedTextTab: vscode.Tab,
		panelColumn: vscode.ViewColumn
	): Promise<void> {
		const uri = openedTextTab.input instanceof vscode.TabInputText
			? openedTextTab.input.uri
			: undefined;
		if (!uri) {
			return;
		}
		const wasPreview = openedTextTab.isPreview;
		const target = resolveRelocationTarget(panelColumn);
		try {
			// 并行 close+open,与 ChatPanel 同一策略,窗口最短。
			const results = await Promise.allSettled([
				vscode.window.tabGroups.close(openedTextTab, true),
				vscode.window.showTextDocument(uri, {
					viewColumn: target,
					preview: wasPreview,
				}),
			]);
			for (const result of results) {
				if (result.status === 'rejected') {
					console.warn(
						'[ClassMate] failed to relocate opened file away from run panel',
						result.reason
					);
				}
			}
		} catch (error) {
			console.warn('[ClassMate] failed to relocate opened file away from run panel', error);
		}
	}

	/** 与 ChatPanel 相同的失活 250ms 冷却期维护。 */
	private _updatePanelActive(active: boolean): void {
		if (active) {
			if (this._inactiveTimeout) {
				clearTimeout(this._inactiveTimeout);
				this._inactiveTimeout = undefined;
			}
			this._panelWasActive = true;
			return;
		}
		if (!this._inactiveTimeout) {
			this._inactiveTimeout = setTimeout(() => {
				this._inactiveTimeout = undefined;
				this._panelWasActive = this._panel.active;
			}, 250);
		}
	}
}
