import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { describe, it } from 'mocha';
import { renderSettingsPageHtml } from '../settings/settingsPageHtml';
import { THEME_FIELDS } from '../settings/themePayload';
import type { LLMConfig } from '../chat/types';

const BASE_CONFIG: LLMConfig = { provider: 'claude', model: 'claude-sonnet-4-7-20251001', apiKeySet: false };

/** 提取渲染页里的全部内联 <script> 源码(按文档顺序)。 */
function extractScripts(html: string): string[] {
	const scripts: string[] = [];
	const pattern = /<script>([\s\S]*?)<\/script>/g;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(html)) !== null) {
		scripts.push(match[1]);
	}
	return scripts;
}

interface FakeElement {
	id: string;
	value: string;
	dataset: Record<string, string>;
	style: Record<string, string>;
	textContent: string;
	className: string;
	listeners: Record<string, (event?: unknown) => void>;
	fire(type: string, event?: unknown): void;
}

function makeElement(id: string): FakeElement {
	const element: FakeElement = {
		id,
		value: '',
		dataset: {},
		style: {},
		textContent: '',
		className: '',
		listeners: {},
		fire(type, event) {
			element.listeners[type]?.(event);
		},
	};
	(element as unknown as Record<string, unknown>).addEventListener = (
		type: string,
		listener: (event?: unknown) => void
	) => {
		element.listeners[type] = listener;
	};
	return element;
}

/**
 * 行为级执行设置页脚本:真实跑 renderSettingsPageHtml 产出的全部 <script>
 * (Node vm + 最小 DOM 替身),模拟"用户用取色器改色 → 点击保存",捕获
 * fetch 发出的 POST 载荷。
 * 背景:b09ff13 之前载荷构造逻辑只存在于 HTML 字符串里,"dataset.custom
 * 永远为空 → 载荷恒空 → 保存完全无效"的回归靠包含性断言测不出来——
 * 本文件让这类盲区永久消失:页面脚本的任何行为变化都会在这里现形。
 */
describe('settings page script (行为级执行)', () => {
	function runPageScripts() {
		const html = renderSettingsPageHtml({
			token: 'test-token',
			port: 49152,
			config: BASE_CONFIG,
			theme: {},
		});
		const elements = new Map<string, FakeElement>();
		const requests: Array<{ url: string; options: { method?: string; body?: string } }> = [];
		const sandbox: Record<string, unknown> = {
			console,
			setTimeout,
			URLSearchParams,
			Promise,
			fetch: async (url: string, options: { method?: string; body?: string }) => {
				requests.push({ url, options });
				return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
			},
			location: { search: '', protocol: 'http:', hostname: '127.0.0.1' },
			history: { replaceState: () => undefined },
			sessionStorage: {
				getItem: () => null,
				setItem: () => undefined,
			},
			document: {
				getElementById: (id: string) => {
					let element = elements.get(id);
					if (!element) {
						element = makeElement(id);
						elements.set(id, element);
					}
					return element;
				},
				querySelectorAll: () => [],
			},
		};
		sandbox.window = sandbox;
		const context = vm.createContext(sandbox);
		for (const script of extractScripts(html)) {
			vm.runInContext(script, context);
		}
		return {
			elements,
			requests,
			get(id: string): FakeElement {
				const element = elements.get(id);
				assert.ok(element, `element ${id} was never touched by the page script`);
				return element;
			},
		};
	}

	it('marks a color input custom on input and posts a non-empty theme payload', async () => {
		const page = runPageScripts();

		// 用户在取色器里改助手气泡背景:input 事件必须把该字段标记为自定义。
		const colorInput = page.get('assistantBubbleBg');
		colorInput.value = '#ff0000';
		colorInput.fire('input');
		assert.strictEqual(colorInput.dataset.custom, '1');

		// change 双保险(G5 第五轮):不同浏览器/输入方式可能只发 change,
		// 监听对两种事件都要置位。
		const other = page.get('userBubbleFg');
		other.value = '#00ff00';
		other.fire('change');
		assert.strictEqual(other.dataset.custom, '1');

		// 未触碰的字段保持非自定义(初始回填不触发 input)。
		assert.strictEqual(page.get('userBubbleBg').dataset.custom ?? '', '');

		// 点击「保存主题」:submit 回调应发出非空且键值正确的 JSON 载荷。
		page.get('theme-form').fire('submit', { preventDefault: () => undefined });
		await new Promise<void>((resolve) => setTimeout(resolve, 20));

		const themePost = page.requests.find(
			(request) => request.options.method === 'POST' && request.url.endsWith('/api/theme')
		);
		assert.ok(themePost, 'theme form did not POST /api/theme');
		// 两个字段(input 触发 + change 触发)都必须进载荷。
		assert.deepStrictEqual(JSON.parse(themePost.options.body ?? '{}'), {
			assistantBubbleBackground: '#ff0000',
			userBubbleForeground: '#00ff00',
		});
	});

	// 全字段参数化(G5 第五轮取证):此前只用 assistantBubbleBackground 一个
	// 字段驱动过链路,用户改的恰好是另两个字段——逐字段盲区只有全字段
	// 驱动能消灭。任何字段在 DOM→监听→载荷任一环掉链子都会在此现形。
	for (const [themeKey, inputId] of THEME_FIELDS) {
		it(`drives the full chain for ${String(themeKey)} (input #${inputId})`, async () => {
			const page = runPageScripts();

			page.get(inputId).value = '#11aa55';
			page.get(inputId).fire('input');
			page.get('theme-form').fire('submit', { preventDefault: () => undefined });
			await new Promise<void>((resolve) => setTimeout(resolve, 20));

			const themePost = page.requests.find(
				(request) => request.options.method === 'POST' && request.url.endsWith('/api/theme')
			);
			assert.ok(themePost, `${String(themeKey)}: theme form did not POST /api/theme`);
			assert.deepStrictEqual(
				JSON.parse(themePost.options.body ?? '{}'),
				{ [themeKey]: '#11aa55' },
				`${String(themeKey)}: saved payload does not carry the changed color`
			);
		});
	}

	it('shows the visible build marker for manual verification', () => {
		const html = renderSettingsPageHtml({
			token: 'test-token',
			port: 49152,
			config: BASE_CONFIG,
			theme: {},
		});
		// G5 复审第一步:核对页脚构建标记,排除"测的不是这份构建"的环境错位。
		assert.match(html, /id="build-marker"[^>]*>ClassMate 设置页 · build /);
	});
});
