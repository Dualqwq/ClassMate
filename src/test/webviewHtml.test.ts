import * as assert from 'assert';
import { describe, it } from 'mocha';
import * as vscode from 'vscode';
import { getChatWebviewHtml } from '../ui/getChatWebviewHtml';
import { getJourneyWebviewHtml } from '../ui/getJourneyWebviewHtml';

describe('ClassMate webview HTML', () => {
	it('loads both the generated JavaScript and CSS bundles', () => {
		const webview = {
			cspSource: 'vscode-webview://test',
			asWebviewUri: (uri: vscode.Uri) => uri,
		} as unknown as vscode.Webview;
		const html = getChatWebviewHtml(
			webview,
			vscode.Uri.file('C:/ClassMate')
		);

		assert.match(html, /dist\/webview\.js/);
		assert.match(html, /dist\/webview\.css/);
		assert.match(html, /rel="stylesheet"/);
	});
});

describe('Journey webview HTML (#12a route 泛化)', () => {
	it('injects the journey route into the shared bundle page', () => {
		const webview = {
			cspSource: 'vscode-webview://test',
			asWebviewUri: (uri: vscode.Uri) => uri,
		} as unknown as vscode.Webview;
		const html = getJourneyWebviewHtml(webview, vscode.Uri.file('C:/ClassMate'));

		assert.match(html, /__CLASSMATE_ROUTE__\s*=\s*"journey"/);
		assert.match(html, /dist\/webview\.js/);
		assert.match(html, /dist\/webview\.css/);
		assert.ok(!html.includes('__CLASSMATE_INITIAL_STATE__'), 'journey 面板不注入 chat 初始状态');
	});
});
