import * as vscode from 'vscode';
import type { WebviewPresenter, WebviewToExtensionMessage } from '../chat/types';
import { getChatWebviewHtml } from './getChatWebviewHtml';
import { ChatSession } from '../chat/ChatSession';

export class ChatViewProvider implements vscode.WebviewViewProvider, WebviewPresenter {
	public static readonly viewType = 'classmate.chatView';

	private _view?: vscode.WebviewView;
	private readonly _extensionUri: vscode.Uri;
	private readonly _onMessage: (message: WebviewToExtensionMessage) => void;
	private readonly _onDisposed: () => void;
	private _disposables: vscode.Disposable[] = [];

	constructor(
		extensionUri: vscode.Uri,
		onMessage: (message: WebviewToExtensionMessage) => void,
		onDisposed: () => void
	) {
		this._extensionUri = extensionUri;
		this._onMessage = onMessage;
		this._onDisposed = onDisposed;
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
	}

	public reveal(preserveFocus?: boolean): void {
		this._view?.show(preserveFocus ?? false);
	}

	public postMessage(message: unknown): void {
		if (this._view) {
			void this._view.webview.postMessage(message);
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
