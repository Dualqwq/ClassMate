import * as vscode from 'vscode';
import type { WebviewPresenter, WebviewToExtensionMessage } from '../chat/types';
import { getChatWebviewHtml } from './getChatWebviewHtml';
import { ChatSession } from '../chat/ChatSession';

/**
 * Resolve which ViewColumn a newly-created ChatPanel should occupy.
 * Exported so the decision logic can be unit-tested without VS Code UI state.
 */
export function resolveChatPanelColumn(
    visibleEditorCount: number,
    activeColumn: vscode.ViewColumn | undefined
): vscode.ViewColumn {
    const hasSplitView = visibleEditorCount > 1;
    if (
        hasSplitView &&
        activeColumn !== undefined &&
        activeColumn !== vscode.ViewColumn.One
    ) {
        return vscode.ViewColumn.One;
    }
    return vscode.ViewColumn.Two;
}

export class ChatPanel implements WebviewPresenter {
	public static readonly viewType = 'classmate.chatPanel';
	private static _currentPanel: ChatPanel | undefined;
	private static _onDidClose?: () => void;

	private readonly _panel: vscode.WebviewPanel;
	private readonly _extensionUri: vscode.Uri;
	private readonly _onDisposed: () => void;
	private readonly _onMessage: (message: WebviewToExtensionMessage) => void;
	private _disposables: vscode.Disposable[] = [];

	public static createOrShow(
		extensionUri: vscode.Uri,
		onMessage: (message: WebviewToExtensionMessage) => void,
		onDisposed: () => void,
		options?: { preserveFocus?: boolean; onDidClose?: () => void }
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
		// so it doesn't cover the code they're reading.
		const targetColumn = resolveChatPanelColumn(visibleEditors.length, activeColumn);

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

		this._update();

		this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
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
