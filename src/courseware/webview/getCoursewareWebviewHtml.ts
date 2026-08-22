import * as vscode from 'vscode';

/**
 * 课件管理页使用独立轻量 HTML，不依赖 Chat/Run 的 React bundle，
 * 减少对本轨之外的前端代码侵入。
 */
export function getCoursewareWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
	const nonce = getNonce();
	return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src https:; img-src ${webview.cspSource} https: data:;">
	<title>ClassMate 课件管理</title>
	<style>
		body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 16px; margin: 0; }
		h1 { font-size: 1.2em; margin: 0 0 12px; }
		.toolbar { display: flex; gap: 8px; margin-bottom: 16px; align-items: center; flex-wrap: wrap; }
		button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 12px; cursor: pointer; border-radius: 2px; white-space: nowrap; }
		button:hover { background: var(--vscode-button-hoverBackground); }
		button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
		button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
		.stats { color: var(--vscode-descriptionForeground); font-size: 0.9em; margin-bottom: 16px; }
		.banner { display: none; margin-bottom: 12px; padding: 8px 12px; border-left: 3px solid var(--vscode-editorWarning-foreground); background: var(--vscode-editorWarning-background); color: var(--vscode-editorWarning-foreground); }
		table { width: 100%; border-collapse: collapse; }
		th, td { text-align: left; padding: 8px; border-bottom: 1px solid var(--vscode-panel-border); }
		th { color: var(--vscode-descriptionForeground); font-weight: normal; }
		.empty { color: var(--vscode-descriptionForeground); padding: 24px 0; }
		.status { padding: 4px 8px; border-radius: 2px; font-size: 0.85em; }
		.status.ok { background: var(--vscode-testing-iconPassed); color: var(--vscode-button-foreground); }
		.status.error { background: var(--vscode-errorForeground); color: var(--vscode-button-foreground); }
		.query-box { display: flex; gap: 8px; margin-top: 24px; align-items: center; }
		.query-box input { flex: 1; padding: 6px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); }
		.result { margin-top: 12px; padding: 8px; background: var(--vscode-textBlockQuote-background); border-left: 3px solid var(--vscode-textBlockQuote-border); }
		.result small { color: var(--vscode-descriptionForeground); }
		.progress { color: var(--vscode-descriptionForeground); font-size: 0.9em; margin-left: auto; }
	</style>
</head>
<body>
	<h1>ClassMate 课件管理</h1>
	<div class="toolbar">
		<button id="importBtn">导入课件 (PDF/PPTX)</button>
		<button id="rebuildBtn" class="secondary">重建搜索图</button>
		<span id="progress" class="progress"></span>
	</div>
	<div id="rebuildBanner" class="banner">课件格式已升级：旧搜索图与新的分块格式不兼容，请点击「重建搜索图」按新格式重新解析已导入的课件。</div>
	<div class="stats" id="stats">加载中…</div>
	<table id="listTable" style="display:none">
		<thead>
			<tr><th>文件名</th><th>页数</th><th>块数</th><th>导入时间</th><th>操作</th></tr>
		</thead>
		<tbody id="listBody"></tbody>
	</table>
	<div id="empty" class="empty" style="display:none">尚未导入任何课件。点击“导入课件”选择文件。</div>
	<div class="query-box">
		<input id="queryInput" type="text" placeholder="输入测试查询，检查检索效果…" />
		<button id="queryBtn">测试检索</button>
	</div>
	<div id="queryResults"></div>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		function post(type, payload) { vscode.postMessage(Object.assign({ type: type }, payload || {})); }
		function setProgress(text) { document.getElementById('progress').textContent = text || ''; }
		document.getElementById('importBtn').addEventListener('click', () => {
			post('importPdf');
		});
		document.getElementById('rebuildBtn').addEventListener('click', () => {
			setProgress('正在重建搜索图…');
			post('rebuildGraph');
		});
		document.getElementById('queryBtn').addEventListener('click', () => {
			const query = document.getElementById('queryInput').value.trim();
			if (!query) return;
			document.getElementById('queryResults').innerHTML = '<div class="result">检索中…</div>';
			post('testQuery', { query: query });
		});
		window.addEventListener('message', (event) => {
			const msg = event.data;
			switch (msg.type) {
				case 'list':
					renderList(msg.items, msg.graphStats);
					break;
				case 'graphStats':
					updateStats(msg.nodes, msg.edges, msg.updatedAt);
					break;
				case 'importProgress':
					// done 且带 message 时显示该状态(如空列表重建提示),否则清空进度。
					setProgress(msg.status === 'done' ? (msg.message || '') : (msg.message || msg.status));
					break;
				case 'testQueryResult':
					renderResults(msg.query, msg.results);
					break;
				case 'error':
					setProgress('错误: ' + msg.message);
					break;
			}
		});
		function updateBanner(needsRebuild) {
			document.getElementById('rebuildBanner').style.display = needsRebuild ? '' : 'none';
		}
		function updateStats(nodes, edges, updatedAt) {
			const items = document.getElementById('listBody').children.length;
			const timeText = updatedAt ? new Date(updatedAt).toLocaleString() : '未建图';
			document.getElementById('stats').textContent = '课件数: ' + items + ' · 图节点: ' + nodes + ' · 图边: ' + edges + ' · 最后更新: ' + timeText;
		}
		function renderList(items, graphStats) {
			const tbody = document.getElementById('listBody');
			tbody.innerHTML = '';
			for (const item of items) {
				const tr = document.createElement('tr');
				tr.innerHTML = '<td>' + escapeHtml(item.fileName) + '</td>' +
					'<td>' + item.pageCount + '</td>' +
					'<td>' + item.chunkCount + '</td>' +
					'<td>' + new Date(item.addedAt).toLocaleString() + '</td>' +
					'<td><button class="secondary" data-id="' + item.id + '">删除</button></td>';
				tbody.appendChild(tr);
			}
			tbody.querySelectorAll('button').forEach(btn => {
				btn.addEventListener('click', () => {
					// 确认弹窗由扩展宿主的原生模态框承担(webview iframe 里 confirm 被禁用),
					// 这里直接发消息。
					post('deleteCourseware', { id: btn.dataset.id });
				});
			});
			document.getElementById('listTable').style.display = items.length ? '' : 'none';
			document.getElementById('empty').style.display = items.length ? 'none' : '';
			updateBanner(graphStats ? graphStats.needsRebuild : false);
			updateStats(graphStats ? graphStats.nodes : 0, graphStats ? graphStats.edges : 0, graphStats ? graphStats.updatedAt : undefined);
		}
		function renderResults(query, results) {
			const container = document.getElementById('queryResults');
			if (!results.length) {
				container.innerHTML = '<div class="result">无匹配片段</div>';
				return;
			}
			container.innerHTML = results.map((r, i) => {
				const unitText = r.unitLabel || ('p.' + r.pageStart);
				const titleText = r.title ? ' · ' + escapeHtml(r.title) : '';
				return '<div class="result"><small>#' + (i + 1) + ' ' + escapeHtml(r.fileName) +
					' · ' + escapeHtml(unitText) + titleText +
					' (score ' + r.score.toFixed(2) + ')</small><br/>' + escapeHtml(r.content.slice(0, 240)) + '…</div>';
			}).join('');
		}
		function escapeHtml(text) {
			return text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
		}
		post('requestList');
	</script>
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
