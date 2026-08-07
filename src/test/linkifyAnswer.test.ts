import * as assert from 'assert';
import { describe, it } from 'mocha';
import { linkifyAnswer, transformReferenceUrl } from '../chat/linkifyAnswer';
import type { ChatReference } from '../chat/types';

function makeRef(partial: Partial<ChatReference> & { uri: string; label: string }): ChatReference {
	return { startLine: undefined, symbol: undefined, ...partial };
}

describe('linkifyAnswer', () => {
	it('returns the content unchanged when there are no references', () => {
		assert.strictEqual(linkifyAnswer('hello sort', []), 'hello sort');
	});

	it('links every occurrence of a unique symbol with the symbol as label', () => {
		const refs = [makeRef({ uri: 'file:///main.cpp', label: 'main.cpp', symbol: 'sort' })];
		const out = linkifyAnswer('sort 有 bug,看看 sort 的实现', refs);
		assert.strictEqual(
			out,
			'[sort](classmate-ref://0) 有 bug,看看 [sort](classmate-ref://0) 的实现'
		);
	});

	it('does not link bare symbols that have multiple targets (宁缺毋滥)', () => {
		const refs = [
			makeRef({ uri: 'file:///main.cpp', label: 'main.cpp', symbol: 'sort' }),
			makeRef({ uri: 'file:///helper.cpp', label: 'helper.cpp', symbol: 'sort' }),
		];
		const out = linkifyAnswer('sort 到底在哪个文件', refs);
		assert.strictEqual(out, 'sort 到底在哪个文件');
	});

	it('links file:line mentions with their natural label', () => {
		const refs = [
			makeRef({ uri: 'file:///main.cpp', label: 'main.cpp', startLine: 12, symbol: 'sort' }),
		];
		const out = linkifyAnswer('看 main.cpp:12 的 sort', refs);
		assert.strictEqual(
			out,
			'看 [main.cpp:12](classmate-ref://0) 的 [sort](classmate-ref://0)'
		);
	});

	it('links single-symbol inline code, skips code blocks and existing links', () => {
		const refs = [makeRef({ uri: 'file:///main.cpp', label: 'main.cpp', symbol: 'sort' })];
		const content = [
			'```cpp',
			'sort(a, n);',
			'```',
			'用 `sort` 排序',
			'代码段 `sort(a, n);` 不链',
			'详见 [sort 文档](https://example.com)',
		].join('\n');
		const out = linkifyAnswer(content, refs);
		assert.ok(out.includes('```cpp\nsort(a, n);\n```'), '代码块内不链接');
		assert.ok(out.includes('用 [sort](classmate-ref://0) 排序'), '单个符号的行内代码应链接');
		assert.ok(out.includes('`sort(a, n);`'), '非单一标识符的行内代码保持代码样式');
		assert.ok(out.includes('[sort 文档](https://example.com)'), '已有链接不修改');
	});

	it('does not link ambiguous symbols inside inline code', () => {
		const refs = [
			makeRef({ uri: 'file:///main.cpp', label: 'main.cpp', symbol: 'sort' }),
			makeRef({ uri: 'file:///helper.cpp', label: 'helper.cpp', symbol: 'sort' }),
		];
		assert.strictEqual(linkifyAnswer('用 `sort` 排序', refs), '用 `sort` 排序');
	});

	it('file:line mention wins over an overlapping bare symbol', () => {
		const refs = [
			makeRef({ uri: 'file:///main.cpp', label: 'main.cpp', startLine: 12, symbol: 'main' }),
		];
		const out = linkifyAnswer('main.cpp:12 里的 main 函数', refs);
		assert.strictEqual(
			out,
			'[main.cpp:12](classmate-ref://0) 里的 [main](classmate-ref://0) 函数'
		);
	});
});

describe('transformReferenceUrl', () => {
	it('preserves classmate-ref links', () => {
		assert.strictEqual(transformReferenceUrl('classmate-ref://0'), 'classmate-ref://0');
	});

	it('keeps safe protocols untouched', () => {
		assert.strictEqual(transformReferenceUrl('https://example.com'), 'https://example.com');
		assert.strictEqual(transformReferenceUrl('mailto:a@b.c'), 'mailto:a@b.c');
	});

	it('strips unsafe protocols like the default sanitizer', () => {
		assert.strictEqual(transformReferenceUrl('javascript:alert(1)'), '');
		assert.strictEqual(transformReferenceUrl('classmate-x://0'), '');
	});
});
