import * as vscode from 'vscode';

export class ChatPanel {
	public static readonly viewType = 'classmate.chatPanel';
	private static currentPanel: ChatPanel | undefined;

	private readonly _panel: vscode.WebviewPanel;
	private readonly _extensionUri: vscode.Uri;
	private _disposables: vscode.Disposable[] = [];

	public static createOrShow(extensionUri: vscode.Uri): void {
		const column = vscode.window.activeTextEditor
			? vscode.window.activeTextEditor.viewColumn
			: undefined;

		// If we already have a panel, show it in the target column.
		if (ChatPanel.currentPanel) {
			ChatPanel.currentPanel._panel.reveal(column);
			return;
		}

		// Otherwise, create a new panel.
		const panel = vscode.window.createWebviewPanel(
			ChatPanel.viewType,
			'ClassMate Chat',
			column || vscode.ViewColumn.One,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist')],
			}
		);

		ChatPanel.currentPanel = new ChatPanel(panel, extensionUri);
	}

	private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
		this._panel = panel;
		this._extensionUri = extensionUri;

		// Set the webview's initial html content.
		this._update();

		// Listen for when the panel is disposed.
		this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

		// Update the content based on view changes.
		this._panel.onDidChangeViewState(
			() => {
				if (this._panel.visible) {
					this._update();
				}
			},
			null,
			this._disposables
		);

		// Handle messages from the webview.
		this._panel.webview.onDidReceiveMessage(
			(message) => {
				void this._handleMessage(message);
			},
			null,
			this._disposables
		);
	}

	public dispose(): void {
		ChatPanel.currentPanel = undefined;

		// Clean up our resources.
		this._panel.dispose();

		while (this._disposables.length) {
			const x = this._disposables.pop();
			if (x) {
				x.dispose();
			}
		}
	}

	private _update(): void {
		this._panel.title = 'ClassMate Chat';
		this._panel.webview.html = this._getHtmlForWebview(this._panel.webview);
	}

	private _getHtmlForWebview(webview: vscode.Webview): string {
		// Local path to main script run in the webview.
		const scriptUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview.js')
		);

		// Use a nonce to only allow specific scripts to be run.
		const nonce = this._getNonce();

		return /* html */ `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src https:; img-src ${webview.cspSource} https: data:;">
				<title>ClassMate Chat</title>
			</head>
			<body>
				<div id="root"></div>
				<script nonce="${nonce}" src="${scriptUri}"></script>
			</body>
			</html>`;
	}

	private _getNonce(): string {
		let text = '';
		const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
		for (let i = 0; i < 32; i++) {
			text += possible.charAt(Math.floor(Math.random() * possible.length));
		}
		return text;
	}

	private async _handleMessage(message: unknown): Promise<void> {
		// TODO: route webview messages in a later task.
		console.log('Received message from ClassMate webview:', message);
	}
}
