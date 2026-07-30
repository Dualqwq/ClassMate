import * as assert from 'assert';
import { describe, it } from 'mocha';
import * as vscode from 'vscode';
import { getChatWebviewHtml } from '../ui/getChatWebviewHtml';

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
