import * as assert from 'assert';
import { describe, it } from 'mocha';
import { tokenizeMarkdown, transformReferenceUrl } from '../chat/linkifyAnswer';

describe('tokenizeMarkdown', () => {
	it('splits code blocks, inline code, links and plain text', () => {
		const content = [
			'```cpp',
			'sort(a, n);',
			'```',
			'用 `sort` 排序,链接 [`sort`](classmate-ref://0) 与补链 [`sort`](classmate-ref://0?i)。',
		].join('\n');
		const segments = tokenizeMarkdown(content);
		assert.deepStrictEqual(
			segments.map((segment) => segment.kind),
			['code-block', 'plain', 'inline-code', 'plain', 'link', 'plain', 'link', 'plain']
		);
	});

	it('keeps an unclosed code fence as one trailing segment', () => {
		const segments = tokenizeMarkdown('前文 ```cpp int x = 1;');
		assert.deepStrictEqual(
			segments.map((segment) => segment.kind),
			['plain', 'code-block']
		);
	});
});

describe('transformReferenceUrl', () => {
	it('preserves classmate-ref links with and without the inferred suffix', () => {
		assert.strictEqual(transformReferenceUrl('classmate-ref://0'), 'classmate-ref://0');
		assert.strictEqual(transformReferenceUrl('classmate-ref://0?i'), 'classmate-ref://0?i');
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
