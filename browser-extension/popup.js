/**
 * ClassMate 浏览器扩展 Popup：展示预览、编辑元数据并触发导入。
 *
 * 探测在 popup 内逐端口进行并实时上屏（G5 二轮要求：断点对用户可见，
 * 不再只给一句笼统失败）；找到端点后把「端口 + payload」交给 service worker
 * 发送 POST——popup 关闭不会掐断请求，VS Code 侧弹窗照常出现。
 */

const LOG_PREFIX = '[ClassMate popup]';
// 与 VS Code 端 server.ts 默认绑定区间保持一致。
const CANDIDATE_PORTS = Array.from({ length: 11 }, (_, i) => 53135 + i);

/**
 * 把探测失败原因归并为用户能读懂的短文案。
 */
function summarizeProbeError(error) {
	if (error && error.name === 'TimeoutError') {
		return '无响应';
	}
	const message = error instanceof Error ? error.message : String(error);
	if (/Failed to fetch/i.test(message)) {
		return '连接被拒';
	}
	return message;
}

/**
 * 逐端口探测 /health，实时回调进度；返回命中端口与全部结果。
 */
async function discoverEndpoint(onProgress) {
	const results = [];
	for (const port of CANDIDATE_PORTS) {
		onProgress(port);
		try {
			const response = await fetch(`http://127.0.0.1:${port}/health`, {
				method: 'GET',
				mode: 'cors',
				signal: AbortSignal.timeout(700),
			});
			const body = await response.json().catch(() => null);
			console.log(`${LOG_PREFIX} probe ${port}: HTTP ${response.status} body=${JSON.stringify(body)}`);
			if (response.ok && body?.ok && typeof body.port === 'number') {
				results.push({ port, ok: true, detail: '✓ 已连接' });
				return { port, results };
			}
			results.push({ port, ok: false, detail: `health 异常(HTTP ${response.status})` });
		} catch (error) {
			console.log(`${LOG_PREFIX} probe ${port}: ${summarizeProbeError(error)}`);
			results.push({ port, ok: false, detail: summarizeProbeError(error) });
		}
	}
	return { port: undefined, results };
}

function formatResults(results) {
	return results.map((r) => `${r.port} ${r.detail}`).join(' / ');
}

document.addEventListener('DOMContentLoaded', async () => {
	const titleInput = /** @type {HTMLInputElement} */ (document.getElementById('title-input'));
	const urlInput = /** @type {HTMLInputElement} */ (document.getElementById('url-input'));
	const preview = /** @type {HTMLTextAreaElement} */ (document.getElementById('preview'));
	const importBtn = /** @type {HTMLButtonElement} */ (document.getElementById('import-btn'));
	const status = /** @type {HTMLParagraphElement} */ (document.getElementById('status'));

	/** @type {{ title: string; url: string; markdown: string; selectionUsed: boolean } | null} */
	let collected = null;

	async function loadPreview() {
		try {
			const response = await chrome.runtime.sendMessage({ type: 'collect' });
			if (!response.ok) {
				status.textContent = response.error || '读取失败';
				return;
			}
			collected = response.data;
			titleInput.value = collected.title || '';
			urlInput.value = collected.url || '';
			preview.value = collected.markdown || '';
			console.log(`${LOG_PREFIX} collected: selection=${collected.selectionUsed ? 'yes' : 'no'}, markdown ${(collected.markdown || '').length} chars`);
			status.textContent = collected.selectionUsed
				? '已读取当前选区。'
				: '未检测到选区，已使用页面正文。';
			importBtn.disabled = (collected.markdown || '').trim().length === 0;
		} catch (error) {
			console.error(`${LOG_PREFIX} load preview failed:`, error);
			status.textContent = `读取失败：${error instanceof Error ? error.message : String(error)}`;
		}
	}

	importBtn.addEventListener('click', async () => {
		if (!collected) {
			return;
		}
		importBtn.disabled = true;
		importBtn.textContent = '导入中…';
		try {
			const payload = {
				title: titleInput.value.trim() || collected.title,
				url: urlInput.value.trim() || collected.url,
				markdown: preview.value,
			};
			console.log(`${LOG_PREFIX} import clicked (markdown ${payload.markdown.length} chars), probing ports ${CANDIDATE_PORTS[0]}-${CANDIDATE_PORTS[CANDIDATE_PORTS.length - 1]}`);
			const { port, results } = await discoverEndpoint((probePort) => {
				status.textContent = `探测 127.0.0.1:${probePort} …`;
			});
			if (!port) {
				throw new Error(
					`未发现 ClassMate 导入服务（${formatResults(results)}）。` +
					'请确认 VS Code 已启动且底部状态栏显示「ClassMate 导入:端口」；' +
					'若状态栏不存在，请在 VS Code 里随便打开一个 .c/.cpp 文件或 Chat 面板激活 ClassMate 后重试。'
				);
			}
			status.textContent = `${formatResults(results)} → 已连接 :${port}，发送中…`;
			const response = await chrome.runtime.sendMessage({ type: 'importWithPort', payload, port });
			console.log(`${LOG_PREFIX} importWithPort response: ${JSON.stringify(response)}`);
			if (response.ok) {
				status.textContent =
					`已发送到 127.0.0.1:${port}。请切换到 VS Code 选择保存位置——` +
					'若未见弹窗，请点击任务栏 VS Code 图标（原生对话框可能落在后台窗口）。';
				importBtn.textContent = '已发送';
			} else {
				throw new Error(response.error || '导入失败');
			}
		} catch (error) {
			console.error(`${LOG_PREFIX} import failed:`, error);
			status.textContent = `导入失败：${error instanceof Error ? error.message : String(error)}`;
			importBtn.disabled = false;
			importBtn.textContent = '重试导入';
		}
	});

	await loadPreview();
});
