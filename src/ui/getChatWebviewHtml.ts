import * as vscode from 'vscode';
import type { ChatState } from '../chat/types';
import { THEME_VARIABLES } from '../chat/classmateTheme';

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
	// 原生主题应用(G5 第七轮):主题曾只在 React 组件里应用——bundle 加载/
	// 组件挂载晚于宿主首条推送,且组件生命周期任何异常都会让颜色静默失效
	// (七轮复测零 ack 的形态)。现下沉到页面内联脚本:HTML 解析完即监听,
	// 不依赖 React;键值对由 THEME_VARIABLES 注入,与写入端单一事实源。
	const themeScript = `<script nonce="${nonce}">
(function () {
	var PAIRS = ${JSON.stringify(THEME_VARIABLES)};
	var SAMPLE = '--classmate-user-bubble-bg';
	function postToHost(msg) {
		if (window.__classmatePostMessage) {
			window.__classmatePostMessage(msg);
		} else {
			(window.__classmatePendingAcks = window.__classmatePendingAcks || []).push(msg);
		}
	}
	window.addEventListener('message', function (event) {
		var msg = event.data;
		if (!msg || msg.type !== 'themeUpdate') { return; }
		var root = document.documentElement;
		var theme = msg.theme || {};
		var count = 0;
		for (var i = 0; i < PAIRS.length; i++) {
			var value = theme[PAIRS[i][0]] || '';
			root.style.setProperty(PAIRS[i][1], value);
			if (value) { count += 1; }
		}
		postToHost({
			type: 'themeApplied',
			surface: ${JSON.stringify(container)},
			variableCount: count,
			sampleVariable: SAMPLE,
			sampleValue: window.getComputedStyle(root).getPropertyValue(SAMPLE)
		});
	});
})();
</script>`;

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
			${themeScript}
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
