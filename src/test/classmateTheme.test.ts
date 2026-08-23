import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { describe, it } from 'mocha';
import { applyClassMateTheme, THEME_VARIABLES, type CssVariableTarget } from '../chat/classmateTheme';

/** 记录 setProperty 调用的根节点替身。 */
function createTarget(): CssVariableTarget & { values: Map<string, string> } {
	const values = new Map<string, string>();
	return {
		values,
		style: {
			setProperty: (name, value) => {
				values.set(name, value);
			},
		},
	};
}

describe('applyClassMateTheme', () => {
	it('writes every theme field to its CSS variable', () => {
		const target = createTarget();
		applyClassMateTheme({
			userBubbleBackground: '#0e639c',
			userBubbleForeground: '#ffffff',
			assistantBubbleBackground: '#37373d',
			assistantBubbleForeground: '#cccccc',
			linkColor: '#4fc1ff',
			refFuncColor: '#dcdcaa',
			refTypeColor: '#4ec9b0',
		}, target);
		assert.deepStrictEqual([...target.values.entries()], [
			['--classmate-user-bubble-bg', '#0e639c'],
			['--classmate-user-bubble-fg', '#ffffff'],
			['--classmate-assistant-bubble-bg', '#37373d'],
			['--classmate-assistant-bubble-fg', '#cccccc'],
			['--classmate-link-color', '#4fc1ff'],
			['--classmate-ref-func', '#dcdcaa'],
			['--classmate-ref-type', '#4ec9b0'],
			['--classmate-ref-var', ''],
			['--classmate-ref-macro', ''],
			['--classmate-ref-std', ''],
			['--classmate-ref-other', ''],
		]);
	});

	it('clears variables for missing fields so var() falls back to VS Code defaults', () => {
		const target = createTarget();
		applyClassMateTheme({ userBubbleBackground: '#0e639c' }, target);
		assert.strictEqual(target.values.get('--classmate-user-bubble-bg'), '#0e639c');
		assert.strictEqual(target.values.get('--classmate-user-bubble-fg'), '');
		assert.strictEqual(target.values.get('--classmate-assistant-bubble-bg'), '');
		assert.strictEqual(target.values.get('--classmate-assistant-bubble-fg'), '');
		assert.strictEqual(target.values.get('--classmate-link-color'), '');
		assert.strictEqual(target.values.get('--classmate-ref-func'), '');
	});

	it('is a no-op without an injected root when no DOM document exists', () => {
		// node/测试环境没有 document:不注入 root 时不抛错即通过。
		assert.doesNotThrow(() => applyClassMateTheme({ linkColor: '#4fc1ff' }));
	});

	it('every written CSS variable has a consumer and vice versa (closed loop)', () => {
		// 变量名闭环(G5 复测纪律):applyClassMateTheme 写入的每个 --classmate-*
		// 必须在 webview 源码里有 var() 消费点;反之 webview 消费的每个
		// --classmate-* 必须有写入点。任一集合多出/缺失即测试红——
		// "变量写了没人消费/消费了没人写"这类断链在编译期不可见。
		const sources = [
			'../../webview/src/classmate.css',
			'../../webview/src/components/MessageBubble.tsx',
			'../../webview/src/components/MarkdownRenderer.tsx',
		].map((relative) =>
			fs.readFileSync(path.join(__dirname, relative), 'utf8')
		);
		const consumed = new Set<string>();
		for (const source of sources) {
			for (const match of source.matchAll(/var\((--classmate-[a-z-]+)/g)) {
				consumed.add(match[1]);
			}
		}
		const written = THEME_VARIABLES.map(([, variable]) => variable);

		for (const variable of written) {
			assert.ok(
				consumed.has(variable),
				`${variable} is written by applyClassMateTheme but consumed nowhere`
			);
		}
		assert.deepStrictEqual(
			[...consumed].sort(),
			[...written].sort(),
			'webview consumes a --classmate-* variable that applyClassMateTheme never writes'
		);
	});
});
