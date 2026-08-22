import type { ClassMateTheme, LLMConfig } from '../chat/types';

export interface SettingsPageData {
	token: string;
	port: number;
	config: LLMConfig;
	theme: ClassMateTheme;
}

export function renderSettingsPageHtml(data: SettingsPageData): string {
	const { token, port, config, theme } = data;
	const initialScript = `window.__CLASSMATE_INITIAL__ = ${JSON.stringify({ token, port, config, theme })};`;

	return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ClassMate 设置</title>
<style>
:root {
	color-scheme: light dark;
	--bg: #0d1117;
	--fg: #c9d1d9;
	--border: #30363d;
	--input-bg: #21262d;
	--button-bg: #238636;
	--button-fg: #ffffff;
}
@media (prefers-color-scheme: light) {
	:root {
		--bg: #ffffff;
		--fg: #24292f;
		--border: #d0d7de;
		--input-bg: #f6f8fa;
		--button-bg: #1f883d;
		--button-fg: #ffffff;
	}
}
* { box-sizing: border-box; }
body {
	font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
	background: var(--bg);
	color: var(--fg);
	max-width: 640px;
	margin: 0 auto;
	padding: 24px 16px;
	line-height: 1.5;
}
h1 { font-size: 20px; margin: 0 0 20px; }
h2 { font-size: 16px; margin: 28px 0 12px; border-bottom: 1px solid var(--border); padding-bottom: 6px; }
label { display: block; margin-bottom: 14px; font-size: 14px; }
input[type="text"], input[type="password"], select {
	display: block;
	width: 100%;
	margin-top: 4px;
	padding: 7px 10px;
	border: 1px solid var(--border);
	border-radius: 6px;
	background: var(--input-bg);
	color: var(--fg);
	font-size: 14px;
}
input[type="color"] {
	width: 56px;
	height: 32px;
	border: 1px solid var(--border);
	border-radius: 6px;
	background: transparent;
	cursor: pointer;
}
.color-row { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }
.color-row label { margin: 0; flex: 1; }
.actions { display: flex; gap: 10px; margin-top: 16px; flex-wrap: wrap; }
button {
	padding: 8px 16px;
	border: 0;
	border-radius: 6px;
	background: var(--button-bg);
	color: var(--button-fg);
	font-size: 14px;
	cursor: pointer;
}
button.secondary { background: var(--input-bg); color: var(--fg); border: 1px solid var(--border); }
button:disabled { opacity: 0.6; cursor: default; }
.status { margin-top: 12px; font-size: 13px; min-height: 20px; }
.status.ok { color: #3fb950; }
.status.err { color: #f85149; }
.hint { font-size: 12px; color: #8b949e; margin-top: 4px; }
.pairing { margin-top: 18px; padding: 12px; border: 1px solid var(--border); border-radius: 8px; font-size: 13px; }
.pairing code { word-break: break-all; }
</style>
</head>
<body>
<h1>⚙ ClassMate 设置</h1>

<h2>模型配置</h2>
<form id="config-form">
	<label>Provider
		<select id="provider">
			<option value="claude">Claude</option>
			<option value="openai">OpenAI</option>
			<option value="deepseek">DeepSeek</option>
		</select>
	</label>
	<label>Model
		<input type="text" id="model" placeholder="例如 gpt-4.1">
	</label>
	<label>API URL（可选）
		<input type="text" id="apiUrl" placeholder="留空使用默认">
	</label>
	<label>API Key
		<input type="password" id="apiKey" placeholder="留空保留当前密钥">
		<div class="hint">密钥不会显示，也不会离开 VS Code SecretStorage。</div>
	</label>

	<label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
		<input type="checkbox" id="fallbackEnabled"> 启用备用模型
	</label>
	<div id="fallback-fields" style="display:none;">
		<label>备用 Provider
			<select id="fallbackProvider">
				<option value="claude">Claude</option>
				<option value="openai">OpenAI</option>
				<option value="deepseek">DeepSeek</option>
			</select>
		</label>
		<label>备用 Model
			<input type="text" id="fallbackModel" placeholder="例如 deepseek-chat">
		</label>
		<label>备用 API URL（可选）
			<input type="text" id="fallbackApiUrl" placeholder="留空使用默认">
		</label>
		<label>备用 API Key
			<input type="password" id="fallbackApiKey" placeholder="留空保留当前密钥">
		</label>
	</div>

	<div class="actions">
		<button type="submit" id="save-config">保存模型配置</button>
	</div>
</form>

<h2>界面主题</h2>
<form id="theme-form">
	<div class="color-row">
		<label>用户气泡背景</label>
		<input type="color" id="userBubbleBg">
		<button type="button" class="secondary" data-reset="userBubbleBackground">重置</button>
	</div>
	<div class="color-row">
		<label>用户气泡文字</label>
		<input type="color" id="userBubbleFg">
		<button type="button" class="secondary" data-reset="userBubbleForeground">重置</button>
	</div>
	<div class="color-row">
		<label>助手气泡背景</label>
		<input type="color" id="assistantBubbleBg">
		<button type="button" class="secondary" data-reset="assistantBubbleBackground">重置</button>
	</div>
	<div class="color-row">
		<label>助手气泡文字</label>
		<input type="color" id="assistantBubbleFg">
		<button type="button" class="secondary" data-reset="assistantBubbleForeground">重置</button>
	</div>
	<div class="color-row">
		<label>超链接颜色</label>
		<input type="color" id="linkColor">
		<button type="button" class="secondary" data-reset="linkColor">重置</button>
	</div>
	<div class="actions">
		<button type="submit" id="save-theme">保存主题</button>
	</div>
</form>

<div class="pairing">
	<strong>连接信息</strong><br>
	端口：<code id="port"></code><br>
	令牌：<code id="token" style="filter:blur(4px);cursor:pointer;" title="点击显示">••••••••</code><br>
	<div class="actions" style="margin-top:10px;">
		<button type="button" class="secondary" id="rotate-token">重置连接令牌</button>
	</div>
</div>

<div id="status" class="status"></div>

<script>${initialScript}</script>
<script>
(function () {
	const urlParams = new URLSearchParams(location.search);
	let token = urlParams.get('t') || window.__CLASSMATE_INITIAL__.token;
	if (urlParams.has('t')) {
		try { sessionStorage.setItem('classmate-token', token); } catch {}
		history.replaceState({}, '', location.pathname);
	} else {
		token = sessionStorage.getItem('classmate-token') || token;
	}

	const port = window.__CLASSMATE_INITIAL__.port;
	const base = location.protocol + '//' + location.hostname + ':' + port;
	const headers = { 'X-ClassMate-Token': token, 'Content-Type': 'application/json' };

	const $ = (id) => document.getElementById(id);
	const statusEl = $('status');
	function status(msg, ok) {
		statusEl.textContent = msg;
		statusEl.className = 'status ' + (ok ? 'ok' : 'err');
	}

	const fieldMap = {
		userBubbleBackground: 'userBubbleBg',
		userBubbleForeground: 'userBubbleFg',
		assistantBubbleBackground: 'assistantBubbleBg',
		assistantBubbleForeground: 'assistantBubbleFg',
		linkColor: 'linkColor',
	};
	const themeKeys = Object.keys(fieldMap);

	function loadConfig(cfg) {
		$('provider').value = cfg.provider || 'claude';
		$('model').value = cfg.model || '';
		$('apiUrl').value = cfg.apiUrl || '';
		const fallback = cfg.fallback;
		$('fallbackEnabled').checked = !!fallback;
		$('fallback-fields').style.display = fallback ? 'block' : 'none';
		if (fallback) {
			$('fallbackProvider').value = fallback.provider || 'deepseek';
			$('fallbackModel').value = fallback.model || '';
			$('fallbackApiUrl').value = fallback.apiUrl || '';
		}
	}

	function loadTheme(theme) {
		for (const [key, id] of Object.entries(fieldMap)) {
			const el = $(id);
			const value = theme[key];
			el.value = value || defaultColor(id);
			el.dataset.custom = value ? '1' : '';
		}
	}

	function defaultColor(id) {
		// Provide sane defaults so color inputs are never empty.
		const map = {
			userBubbleBg: '#0e639c',
			userBubbleFg: '#ffffff',
			assistantBubbleBg: '#37373d',
			assistantBubbleFg: '#cccccc',
			linkColor: '#4fc1ff',
		};
		return map[id] || '#888888';
	}

	$('fallbackEnabled').addEventListener('change', () => {
		$('fallback-fields').style.display = $('fallbackEnabled').checked ? 'block' : 'none';
	});

	$('config-form').addEventListener('submit', async (e) => {
		e.preventDefault();
		const body = {
			provider: $('provider').value,
			model: $('model').value.trim(),
			apiUrl: $('apiUrl').value.trim() || undefined,
			apiKey: $('apiKey').value.trim() || undefined,
			fallback: $('fallbackEnabled').checked ? {
				provider: $('fallbackProvider').value,
				model: $('fallbackModel').value.trim(),
				apiUrl: $('fallbackApiUrl').value.trim() || undefined,
				apiKey: $('fallbackApiKey').value.trim() || undefined,
			} : null,
		};
		try {
			const res = await fetch(base + '/api/config', { method: 'POST', headers, body: JSON.stringify(body) });
			if (!res.ok) throw new Error(await res.text());
			status('模型配置已保存', true);
			const refreshed = await (await fetch(base + '/api/config', { headers })).json();
			loadConfig(refreshed);
		} catch (err) {
			status('保存失败：' + err.message, false);
		}
	});

	$('theme-form').addEventListener('submit', async (e) => {
		e.preventDefault();
		const body = {};
		for (const key of themeKeys) {
			const el = $(fieldMap[key]);
			body[key] = el.dataset.custom ? el.value : '';
		}
		try {
			const res = await fetch(base + '/api/theme', { method: 'POST', headers, body: JSON.stringify(body) });
			if (!res.ok) throw new Error(await res.text());
			status('主题已保存并同步到 Chat 面板', true);
		} catch (err) {
			status('保存失败：' + err.message, false);
		}
	});

	document.querySelectorAll('[data-reset]').forEach((btn) => {
		btn.addEventListener('click', () => {
			const key = btn.dataset.reset;
			const el = $(fieldMap[key]);
			el.value = defaultColor(el.id);
			el.dataset.custom = '';
		});
	});

	$('rotate-token').addEventListener('click', async () => {
		try {
			const res = await fetch(base + '/api/token/rotate', { method: 'POST', headers });
			if (!res.ok) throw new Error(await res.text());
			const data = await res.json();
			token = data.token;
			try { sessionStorage.setItem('classmate-token', token); } catch {}
			headers['X-ClassMate-Token'] = token;
			status('令牌已重置，页面将刷新', true);
			setTimeout(() => location.href = base + '/?t=' + encodeURIComponent(token), 800);
		} catch (err) {
			status('重置失败：' + err.message, false);
		}
	});

	$('token').addEventListener('click', function () {
		this.textContent = token;
		this.style.filter = 'none';
	});

	$('port').textContent = port;
	loadConfig(window.__CLASSMATE_INITIAL__.config);
	loadTheme(window.__CLASSMATE_INITIAL__.theme);
})();
</script>
</body>
</html>`;
}
