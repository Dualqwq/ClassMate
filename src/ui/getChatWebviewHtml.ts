import * as vscode from 'vscode';
import type { ChatState } from '../chat/types';

export function getChatWebviewHtml(
	webview: vscode.Webview,
	extensionUri: vscode.Uri,
	initialState?: ChatState,
	container: 'view' | 'panel' = 'view'
): string {
	const scriptUri = webview.asWebviewUri(
		vscode.Uri.joinPath(extensionUri, 'dist', 'webview.js')
	);
	const styleUri = webview.asWebviewUri(
		vscode.Uri.joinPath(extensionUri, 'dist', 'webview.css')
	);
	const nonce = getNonce();
	const stateScript = initialState
		? `<script nonce="${nonce}">window.__CLASSMATE_INITIAL_STATE__ = ${JSON.stringify(initialState)}; window.__CLASSMATE_CONTAINER__ = ${JSON.stringify(container)};</script>`
		: '';

	return `<!DOCTYPE html>
		<html lang="en">
		<head>
			<meta charset="UTF-8">
			<meta name="viewport" content="width=device-width, initial-scale=1.0">
			<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src https:; img-src ${webview.cspSource} https: data:;">
			<title>ClassMate Chat</title>
			<link rel="stylesheet" href="${styleUri}">
		</head>
		<body>
			<div id="root"></div>
			${stateScript}
			<script nonce="${nonce}" src="${scriptUri}"></script>
		</body>
		</html>`;
}

function getNonce(): string {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}
