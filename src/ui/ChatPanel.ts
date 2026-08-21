import * as vscode from 'vscode';
import type { WebviewPresenter, WebviewToExtensionMessage } from '../chat/types';
import { getChatWebviewHtml } from './getChatWebviewHtml';
import { ChatSession } from '../chat/ChatSession';
import { registerClassMatePanel, resolveNewPanelColumn, resolveRelocationTarget } from './panelGrouping';

export class ChatPanel implements WebviewPresenter {
	public static readonly viewType = 'classmate.chatPanel';
	private static _currentPanel: ChatPanel | undefined;
	private static _onDidClose?: () => void;

	private readonly _panel: vscode.WebviewPanel;
	private readonly _extensionUri: vscode.Uri;
	private readonly _onDisposed: () => void;
	private readonly _onMessage: (message: WebviewToExtensionMessage) => void;
	private _disposables: vscode.Disposable[] = [];
	/** 面板是否为 active 标签(打开新文件前),由 viewState 与 tab 事件共同维护。 */
	private _panelWasActive = false;
	private _relocating = false;
	private _inactiveTimeout: ReturnType<typeof setTimeout> | undefined;

	public static createOrShow(
		extensionUri: vscode.Uri,
		onMessage: (message: WebviewToExtensionMessage) => void,
		onDisposed: () => void,
		options?: { preserveFocus?: boolean; onDidClose?: () => void; activeEditorIsClassMateOutput?: boolean }
	): ChatPanel {
		const activeEditor = vscode.window.activeTextEditor;
		const visibleEditors = vscode.window.visibleTextEditors;
		const hasSplitView = visibleEditors.length > 1;
		const activeColumn = activeEditor?.viewColumn;

		if (ChatPanel._currentPanel) {
			ChatPanel._currentPanel._panel.reveal(activeColumn, options?.preserveFocus ?? false);
			return ChatPanel._currentPanel;
		}

		ChatPanel._onDidClose = options?.onDidClose;

		// If the user already has a split view (>=2 visible text editors), place
		// the chat panel in a column that does not contain the active source editor
		// so it doesn't cover the code they're reading. Exception: when the active
		// editor is a ClassMate output virtual doc (compile_result.txt), the panel
		// joins its group instead — both are ClassMate surfaces.
		const targetColumn = resolveNewPanelColumn(visibleEditors.length, activeColumn, {
			activeEditorIsClassMateOutput: options?.activeEditorIsClassMateOutput,
		});

		const panel = vscode.window.createWebviewPanel(
			ChatPanel.viewType,
			'ClassMate Chat',
			{ viewColumn: targetColumn, preserveFocus: options?.preserveFocus ?? false },
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist')],
			}
		);

		ChatPanel._currentPanel = new ChatPanel(panel, extensionUri, onMessage, onDisposed);
		return ChatPanel._currentPanel;
	}

	public static revive(
		panel: vscode.WebviewPanel,
		extensionUri: vscode.Uri,
		onMessage: (message: WebviewToExtensionMessage) => void,
		onDisposed: () => void
	): ChatPanel {
		ChatPanel._currentPanel = new ChatPanel(panel, extensionUri, onMessage, onDisposed);
		return ChatPanel._currentPanel;
	}

	public static closeCurrent(skipCallback = false): void {
		if (skipCallback) {
			ChatPanel._onDidClose = undefined;
		}
		ChatPanel._currentPanel?.dispose();
	}

	public static hasCurrent(): boolean {
		return ChatPanel._currentPanel !== undefined;
	}

	public static revealCurrent(preserveFocus?: boolean): void {
		ChatPanel._currentPanel?._panel.reveal(undefined, preserveFocus ?? false);
	}

	private _isDisposed = false;

	private constructor(
		panel: vscode.WebviewPanel,
		extensionUri: vscode.Uri,
		onMessage: (message: WebviewToExtensionMessage) => void,
		onDisposed: () => void
	) {
		this._panel = panel;
		this._extensionUri = extensionUri;
		this._onMessage = onMessage;
		this._onDisposed = onDisposed;
		this._panelWasActive = panel.active;

		this._update();

		this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
		this._panel.onDidChangeViewState(
			(event) => this._updatePanelActive(event.webviewPanel.active),
			null,
			this._disposables
		);
		this._disposables.push(
			vscode.window.tabGroups.onDidChangeTabs((event) => this._handleTabChange(event))
		);
		// 登记到 ClassMate 面板注册表:ADD2 分组决策(见 ui/panelGrouping.ts)
		// 以"任一已登记面板的 active 列"为准,不绑死 ChatPanel,Run Panel 直接复用。
		this._disposables.push(
			registerClassMatePanel({
				viewType: ChatPanel.viewType,
				getActiveColumn: () => (this._panel.active ? this._panel.viewColumn : undefined),
			})
		);
		this._panel.webview.onDidReceiveMessage(
			(message) => this._handleMessage(message),
			null,
			this._disposables
		);
	}

	public get webview(): vscode.Webview {
		return this._panel.webview;
	}

	public postMessage(message: unknown): void {
		void this._panel.webview.postMessage(message);
	}

	public dispose(): void {
		if (this._isDisposed) {
			return;
		}
		this._isDisposed = true;
		ChatPanel._currentPanel = undefined;
		this._onDisposed();
		this._panel.dispose();
		while (this._disposables.length) {
			const x = this._disposables.pop();
			if (x) {
				x.dispose();
			}
		}
		ChatPanel._onDidClose?.();
		ChatPanel._onDidClose = undefined;
	}

	/**
	 * 新文本文件开进面板所在组时的处理:仅在面板是打开前的 active 标签时,
	 * 把新文件挪到对侧分屏,避免面板被盖住。
	 *
	 * 不用 TabInputWebview 匹配面板 tab:Tab API 里 webview 面板的 viewType
	 * 带 `mainThreadWebview-` 内部前缀,不可靠。改为用 WebviewPanel.viewColumn
	 * 定位面板所在组,用 _panelWasActive(viewState 维护 + 冷却期)判断
	 * "打开新文件前面板是否 active"。
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
		console.log(
			'[ClassMate] relocating newly opened file away from chat panel',
			uri.toString(),
			'-> column',
			target as number
		);
		try {
			// 并行:关掉面板组里的原 tab + 在对侧列打开。close 的 IPC 延迟(~80ms)
			// 追不上 VS Code 的激活,串行会多出一段"文件哪都不在"的空窗,
			// 并行能让文件一出现就在对侧列,面板组被占用的窗口最短。
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
						'[ClassMate] failed to relocate opened file away from chat panel',
						result.reason
					);
				}
			}
		} catch (error) {
			console.warn('[ClassMate] failed to relocate opened file away from chat panel', error);
		}
	}

	/**
	 * viewState 维护面板 active 状态。失活时带 250ms 冷却期:同一用户操作里
	 * tab 事件可能稍后才到达,冷却期内仍视为"此前 active"。
	 */
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

	private _update(): void {
		this._panel.title = 'ClassMate Chat';
		const session = ChatSession.getInstance();
		this._panel.webview.html = getChatWebviewHtml(
			this._panel.webview,
			this._extensionUri,
			session.getState(),
			'panel'
		);
	}

	private _handleMessage(message: WebviewToExtensionMessage): void {
		this._onMessage(message);
	}
}
