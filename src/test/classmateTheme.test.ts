import * as assert from 'assert';
import { describe, it } from 'mocha';
import { applyClassMateTheme, type CssVariableTarget } from '../chat/classmateTheme';

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
		}, target);
		assert.deepStrictEqual([...target.values.entries()], [
			['--classmate-user-bubble-bg', '#0e639c'],
			['--classmate-user-bubble-fg', '#ffffff'],
			['--classmate-assistant-bubble-bg', '#37373d'],
			['--classmate-assistant-bubble-fg', '#cccccc'],
			['--classmate-link-color', '#4fc1ff'],
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
	});

	it('is a no-op without an injected root when no DOM document exists', () => {
		// node/测试环境没有 document:不注入 root 时不抛错即通过。
		assert.doesNotThrow(() => applyClassMateTheme({ linkColor: '#4fc1ff' }));
	});
});
