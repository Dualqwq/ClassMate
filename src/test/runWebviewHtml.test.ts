import * as assert from 'assert';
import { describe, it } from 'mocha';
import * as vscode from 'vscode';
import { getRunWebviewHtml } from '../ui/getRunWebviewHtml';

describe('Run 面板 webview HTML', () => {
	it('与 Chat 共享同一 bundle,并注入 run 路由', () => {
		const webview = {
			cspSource: 'vscode-webview://test',
			asWebviewUri: (uri: vscode.Uri) => uri,
		} as unknown as vscode.Webview;
		const html = getRunWebviewHtml(webview, vscode.Uri.file('C:/ClassMate'));

		// 共享 bundle(grill R2-Q3):同一个 dist/webview.js / webview.css
		assert.match(html, /dist\/webview\.js/);
		assert.match(html, /dist\/webview\.css/);
		// route 切换:注入 __CLASSMATE_ROUTE__ = "run"
		assert.match(html, /__CLASSMATE_ROUTE__\s*=\s*"run"/);
		assert.match(html, /rel="stylesheet"/);
	});
});
