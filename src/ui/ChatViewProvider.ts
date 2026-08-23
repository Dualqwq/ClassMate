import * as vscode from 'vscode';
import type { WebviewPresenter, WebviewToExtensionMessage } from '../chat/types';
import { getChatWebviewHtml } from './getChatWebviewHtml';
import { ChatSession } from '../chat/ChatSession';
import { themeLog } from '../chat/themeDiagnostics';

export class ChatViewProvider implements vscode.WebviewViewProvider, WebviewPresenter {
	public static readonly viewType = 'classmate.chatView';

	private _view?: vscode.WebviewView;
	private readonly _extensionUri: vscode.Uri;
	private readonly _onMessage: (message: WebviewToExtensionMessage) => void;
	private readonly _onDisposed: () => void;
	private readonly _onResolved?: () => void;
	private _disposables: vscode.Disposable[] = [];

	constructor(
		extensionUri: vscode.Uri,
		onMessage: (message: WebviewToExtensionMessage) => void,
		onDisposed: () => void,
		onResolved?: () => void
	) {
		this._extensionUri = extensionUri;
		this._onMessage = onMessage;
		this._onDisposed = onDisposed;
		this._onResolved = onResolved;
	}

	public resolveWebviewView(
		webviewView: vscode.WebviewView,
		context: vscode.WebviewViewResolveContext,
		token: vscode.CancellationToken
	): void {
		this._view = webviewView;

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'dist')],
		};

		webviewView.webview.html = getChatWebviewHtml(
			webviewView.webview,
			this._extensionUri,
			ChatSession.getInstance().getState(),
			'view'
		);

		webviewView.webview.onDidReceiveMessage(
			(message) => this._onMessage(message),
			undefined,
			this._disposables
		);

		webviewView.onDidDispose(
			() => {
				this._view = undefined;
				this._onDisposed();
			},
			undefined,
			this._disposables
		);

		// WebviewView 被隐藏(容器收起或 when 子句失效)时可能被销毁,再次显示时
		// 会重新 resolve。attach 是幂等的,这里重挂一次以恢复广播(streaming/stateSync)。
		this._onResolved?.();
	}

	public reveal(preserveFocus?: boolean): void {
		if (!this._view) {
			// 视图尚未实例化(从未打开过 sidebar,或隐藏后被销毁)。
			// 调用方必须先保证 when 子句为 true,这里用原生命令实例化并显示。
			void vscode.commands.executeCommand('classmate.chatView.focus');
			return;
		}
		this._view?.show(preserveFocus ?? false);
		// Re-sync state when the view is revealed after being hidden, so that
		// draft text and messages updated in the panel are reflected here.
		void this._view?.webview.postMessage({
			type: 'stateSync',
			state: ChatSession.getInstance().getState(),
		});
	}

	public postMessage(message: unknown): void {
		if (this._view) {
			const messageType = (message as { type?: string }).type ?? 'unknown';
			// 送达失败不再静默;主题消息落 [ClassMate Theme] 送达结果。
			this._view.webview.postMessage(message).then(
				(delivered) => {
					if (messageType === 'themeUpdate') {
						themeLog(`view "Chat Sidebar": themeUpdate delivered=${delivered}`);
					}
				},
				(error) => {
					console.warn('[ClassMate] chat view postMessage failed', error);
					if (messageType === 'themeUpdate') {
						themeLog(`view "Chat Sidebar": themeUpdate FAILED (${String(error)})`);
					}
				}
			);
		}
	}

	public dispose(): void {
		while (this._disposables.length) {
			const x = this._disposables.pop();
			if (x) {
				x.dispose();
			}
		}
		this._view = undefined;
		this._onDisposed();
	}
}
