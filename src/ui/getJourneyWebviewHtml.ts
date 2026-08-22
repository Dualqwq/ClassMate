import * as vscode from 'vscode';

/**
 * Journey 面板的 webview HTML(#12a)。与 Chat/Run **共享一个 React bundle**
 * (dist/webview.js),靠注入 `__CLASSMATE_ROUTE__` 让同一 bundle 里的 App
 * 切到 journey 路由(route 泛化的第三个消费者);不另起独立 bundle。
 */
export function getJourneyWebviewHtml(
	webview: vscode.Webview,
	extensionUri: vscode.Uri
): string {
	const scriptUri = webview.asWebviewUri(
		vscode.Uri.joinPath(extensionUri, 'dist', 'webview.js')
	);
	const styleUri = webview.asWebviewUri(
		vscode.Uri.joinPath(extensionUri, 'dist', 'webview.css')
	);
	const nonce = getNonce();

	return `<!DOCTYPE html>
		<html lang="en">
		<head>
			<meta charset="UTF-8">
			<meta name="viewport" content="width=device-width, initial-scale=1.0">
			<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src https:; img-src ${webview.cspSource} https: data:;">
			<title>ClassMate 调试历程</title>
			<link rel="stylesheet" href="${styleUri}">
		</head>
		<body>
			<div id="root"></div>
			<script nonce="${nonce}">window.__CLASSMATE_ROUTE__ = "journey";</script>
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
