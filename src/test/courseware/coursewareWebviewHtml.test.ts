import * as assert from 'assert';
import { describe, it } from 'mocha';
import * as vscode from 'vscode';
import { getCoursewareWebviewHtml } from '../../courseware/webview/getCoursewareWebviewHtml';

describe('课件管理页 webview HTML', () => {
	function renderHtml(): string {
		const webview = {
			cspSource: 'vscode-webview://test',
			asWebviewUri: (uri: vscode.Uri) => uri,
		} as unknown as vscode.Webview;
		return getCoursewareWebviewHtml(webview, vscode.Uri.file('C:/ClassMate'));
	}

	it('删除按钮不再依赖被 webview 禁用的 confirm()（回归锚点：删除点了没反应）', () => {
		const html = renderHtml();
		assert.ok(!html.includes('confirm('), 'webview 内不得使用 window.confirm');
		assert.match(html, /post\('deleteCourseware', \{ id: btn\.dataset\.id \}\)/);
	});

	it('重建按钮与用户可见文案使用「搜索图」而非 GraphRAG', () => {
		const html = renderHtml();
		assert.match(html, /重建搜索图/);
		assert.match(html, /正在重建搜索图…/);
		assert.ok(!html.includes('GraphRAG'), '管理页面向用户的文案不得出现 GraphRAG 术语');
	});

	it('操作列按钮保持横排不逐字换行', () => {
		const html = renderHtml();
		assert.match(html, /white-space:\s*nowrap/);
	});

	it('旧格式图触发「课件格式已升级，请重建搜索图」横幅（期 1 迁移提示）', () => {
		const html = renderHtml();
		assert.match(html, /课件格式已升级/);
		assert.match(html, /重建搜索图」按新格式重新解析/);
		// 横幅由 list 消息里的 needsRebuild 标记驱动
		assert.match(html, /updateBanner\(graphStats \? graphStats\.needsRebuild : false\)/);
	});

	it('检索结果列表展示单元标签（slide/p.）与标题', () => {
		const html = renderHtml();
		assert.match(html, /r\.unitLabel \|\| \('p\.' \+ r\.pageStart\)/);
		assert.match(html, /r\.title/);
	});

	it('检索结果渲染为溯源超链接，点击发 openCoursewareSource（期 1.5）', () => {
		const html = renderHtml();
		assert.match(html, /source-link/);
		assert.match(html, /'《' \+ r\.fileName \+ '》'/);
		assert.match(html, /post\('openCoursewareSource', \{ chunkId: r\.chunkId \}\)/);
	});
});
