/**
 * ClassMate 浏览器扩展 Service Worker：右键菜单与导入请求转发。
 */

const DEFAULT_PORT = 0;
const PORT_STORAGE_KEY = 'classmateImportPort';
// 关键节点日志前缀:在 chrome://extensions → Service Worker 控制台查看,
// 用于定位"选中文字 → collect → POST /import"断在哪一段。
const LOG_PREFIX = '[ClassMate import]';

/**
 * 从存储或默认配置获取 VS Code 端点端口。
 */
async function getImportPort() {
	const stored = await chrome.storage.local.get(PORT_STORAGE_KEY);
	return typeof stored[PORT_STORAGE_KEY] === 'number'
		? stored[PORT_STORAGE_KEY]
		: DEFAULT_PORT;
}

/**
 * 探测 VS Code 端实际监听的端口。
 * 若存储端口为 0 或探测失败,尝试常见端口 53135–53145
 * (与 VS Code 端 server.ts 的默认绑定区间保持一致)。
 */
async function resolveListeningPort() {
	const configured = await getImportPort();
	const candidates = configured > 0
		? [configured]
		: Array.from({ length: 11 }, (_, i) => 53135 + i);
	console.log(`${LOG_PREFIX} discovering endpoint (configured port: ${configured > 0 ? configured : 'auto'}, candidates: ${candidates.join(', ')})`);

	for (const port of candidates) {
		try {
			const response = await fetch(`http://127.0.0.1:${port}/health`, {
				method: 'GET',
				mode: 'cors',
			});
			const body = await response.json().catch(() => null);
			console.log(`${LOG_PREFIX} probe ${port}: HTTP ${response.status} body=${JSON.stringify(body)}`);
			if (response.ok && body?.ok && typeof body.port === 'number') {
				console.log(`${LOG_PREFIX} endpoint discovered at port ${port}`);
				return body.port;
			}
		} catch (error) {
			console.log(`${LOG_PREFIX} port ${port}: not listening (${error instanceof Error ? error.message : String(error)})`);
		}
	}
	console.error(`${LOG_PREFIX} no ClassMate import endpoint found in candidate ports`);
	return undefined;
}

/**
 * 向指定端口发送导入请求（popup 已探测命中后经此直连,避免重复全量探测）。
 */
async function postImportToPort(port, payload) {
	console.log(`${LOG_PREFIX} POST http://127.0.0.1:${port}/import (markdown ${payload?.markdown?.length ?? 0} chars)`);
	let response;
	try {
		response = await fetch(`http://127.0.0.1:${port}/import`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload),
			mode: 'cors',
		});
	} catch (error) {
		console.error(`${LOG_PREFIX} POST to port ${port} failed:`, error);
		throw new Error(`无法连接 127.0.0.1:${port}（${error instanceof Error ? error.message : String(error)}）。服务可能刚下线,请重试。`);
	}
	if (!response.ok) {
		const text = await response.text().catch(() => '');
		console.error(`${LOG_PREFIX} import rejected by VS Code: HTTP ${response.status} ${text}`);
		throw new Error(`导入失败 (${response.status}): ${text}`);
	}
	const data = await response.json();
	console.log(`${LOG_PREFIX} import accepted by VS Code; native save dialog should be visible (若未见弹窗请切换到 VS Code 窗口,对话框可能落在后台窗口)`);
	return data;
}

/**
 * 探测并向 VS Code 本地端点发送导入请求。
 */
async function postImport(payload) {
	const port = await resolveListeningPort();
	if (!port) {
		throw new Error('未找到 ClassMate 导入服务。请确认 VS Code 中 ClassMate 扩展已激活（状态栏应显示「ClassMate 导入:端口」）。');
	}
	return postImportToPort(port, payload);
}

/**
 * 从当前活动标签页收集题目信息。
 */
async function collectFromActiveTab() {
	const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
	if (!tab?.id) {
		throw new Error('无法获取当前标签页。');
	}
	try {
		const result = await chrome.tabs.sendMessage(tab.id, { type: 'classmate-collect' });
		if (!result || typeof result.markdown !== 'string') {
			throw new Error('无法读取页面内容。请刷新页面后重试。');
		}
		console.log(`${LOG_PREFIX} collected from tab ${tab.id}: selection=${result.selectionUsed ? 'yes' : 'no'}, markdown ${result.markdown.length} chars`);
		return result;
	} catch (error) {
		console.log(`${LOG_PREFIX} first collect attempt failed (${error instanceof Error ? error.message : String(error)}), reinjecting content script`);
		// 内容脚本可能尚未注入（如页面打开后才安装扩展），尝试重新注入后重试一次。
		await chrome.scripting.executeScript({
			target: { tabId: tab.id },
			files: ['content.js'],
		});
		const result = await chrome.tabs.sendMessage(tab.id, { type: 'classmate-collect' });
		if (!result || typeof result.markdown !== 'string') {
			throw new Error('无法读取页面内容。请刷新页面后重试。');
		}
		console.log(`${LOG_PREFIX} collected after reinject from tab ${tab.id}: markdown ${result.markdown.length} chars`);
		return result;
	}
}

chrome.runtime.onInstalled.addListener(() => {
	chrome.contextMenus.create({
		id: 'classmate-import-selection',
		title: '以 Markdown 导入到 ClassMate',
		contexts: ['selection'],
	}, () => {
		// 菜单项已存在时会报错，忽略该错误。
		chrome.runtime.lastError;
	});
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
	if (info.menuItemId !== 'classmate-import-selection' || !tab?.id) {
		return;
	}
	try {
		const data = await collectFromActiveTab();
		await postImport(data);
	} catch (error) {
		console.error(`${LOG_PREFIX} context-menu import failed:`, error);
		// 错误通过 badge 或通知展示；保持 service worker 轻量。
		await chrome.action.setBadgeText({ text: '!' });
		await chrome.action.setBadgeBackgroundColor({ color: '#d32f2f' });
	}
});

// 向 popup 暴露内部辅助函数（通过消息通道）。
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
	const { type } = message;
	console.log(`${LOG_PREFIX} background received message: ${type}`);
	if (type === 'collect') {
		collectFromActiveTab()
			.then((data) => sendResponse({ ok: true, data }))
			.catch((error) => {
				console.error(`${LOG_PREFIX} collect failed:`, error);
				sendResponse({ ok: false, error: error.message });
			});
		return true;
	}
	if (type === 'import') {
		postImport(message.payload)
			.then((data) => sendResponse({ ok: true, data }))
			.catch((error) => {
				console.error(`${LOG_PREFIX} import failed:`, error);
				sendResponse({ ok: false, error: error.message });
			});
		return true;
	}
	if (type === 'importWithPort') {
		// popup 已逐端口探测命中后走此直连路径;校验端口防任意调用。
		const port = message.port;
		if (!Number.isInteger(port) || port <= 0 || port > 65535) {
			sendResponse({ ok: false, error: `非法端口: ${String(port)}` });
			return true;
		}
		postImportToPort(port, message.payload)
			.then((data) => sendResponse({ ok: true, data }))
			.catch((error) => {
				console.error(`${LOG_PREFIX} importWithPort(${port}) failed:`, error);
				sendResponse({ ok: false, error: error.message });
			});
		return true;
	}
	if (type === 'setPort') {
		chrome.storage.local.set({ [PORT_STORAGE_KEY]: message.port })
			.then(() => sendResponse({ ok: true }))
			.catch((error) => sendResponse({ ok: false, error: error.message }));
		return true;
	}
	return false;
});
