import * as assert from 'assert';
import { describe, it } from 'mocha';
import {
	inferenceLinkifyAnswer,
	summarizeReferenceLinks,
} from '../chat/answerReferenceRenderer';
import { transformReferenceUrl } from '../chat/linkifyAnswer';
import type { ChatReference } from '../chat/types';

function makeRef(partial: Partial<ChatReference> & { uri: string; label: string }): ChatReference {
	return { startLine: undefined, symbol: undefined, ...partial };
}

describe('inferenceLinkifyAnswer (展示层保守补链)', () => {
	it('returns the content unchanged when there are no references and no code files', () => {
		assert.strictEqual(inferenceLinkifyAnswer('hello `sort`', []), 'hello `sort`');
	});

	it('never links plain-text identifier words, even when the symbol is unique (红线)', () => {
		const refs = [makeRef({ uri: 'file:///main.cpp', label: 'main.cpp', symbol: 'sort' })];
		assert.strictEqual(
			inferenceLinkifyAnswer('sort 有 bug,看看 sort 的实现', refs),
			'sort 有 bug,看看 sort 的实现'
		);
	});

	it('links ANY plain-text mention of a workspace C/C++ file name (用户边界: 文件名任意提及)', () => {
		const refs = [makeRef({ uri: 'file:///main.cpp', label: 'main.cpp', symbol: 'sort' })];
		const out = inferenceLinkifyAnswer(
			'打开 main.cpp 看,monster.h 里也有问题,README.md 不链。',
			refs,
			{ codeFiles: ['monster.h'] }
		);
		// main.cpp 经引用目录(基准);monster.h 经工作区文件目录(无行号);
		// README.md 不是代码文件,不链。
		assert.strictEqual(
			out,
			'打开 [main.cpp](classmate-ref://0?i) 看,[monster.h](classmate-ref://1?i) 里也有问题,README.md 不链。'
		);
	});

	it('links plain-text file mentions even with zero references (fallback appended)', () => {
		const out = inferenceLinkifyAnswer('看 src/create.h 的定义', [], {
			codeFiles: ['src/create.h'],
		});
		assert.strictEqual(out, '看 [src/create.h](classmate-ref://0?i) 的定义');
	});

	it('does not link file names absent from the code-file list', () => {
		assert.strictEqual(
			inferenceLinkifyAnswer('看 util.h 的定义', []),
			'看 util.h 的定义'
		);
	});

	it('links inline-code file names too', () => {
		const refs = [makeRef({ uri: 'file:///main.cpp', label: 'main.cpp', symbol: 'sort' })];
		assert.strictEqual(
			inferenceLinkifyAnswer('改 `main.cpp` 与 `monster.h`', refs, { codeFiles: ['monster.h'] }),
			'改 [`main.cpp`](classmate-ref://0?i) 与 [`monster.h`](classmate-ref://1?i)'
		);
	});

	it('links inline-code mentions of a unique symbol with the inferred suffix', () => {
		const refs = [makeRef({ uri: 'file:///main.cpp', label: 'main.cpp', symbol: 'sort' })];
		assert.strictEqual(
			inferenceLinkifyAnswer('用 `sort` 排序,再检查 `sort` 的边界', refs),
			'用 [`sort`](classmate-ref://0?i) 排序,再检查 [`sort`](classmate-ref://0?i) 的边界'
		);
	});

	it('does not link inline code when the symbol has multiple targets (宁缺毋滥)', () => {
		const refs = [
			makeRef({ uri: 'file:///main.cpp', label: 'main.cpp', symbol: 'sort' }),
			makeRef({ uri: 'file:///helper.cpp', label: 'helper.cpp', symbol: 'sort' }),
		];
		assert.strictEqual(inferenceLinkifyAnswer('用 `sort` 排序', refs), '用 `sort` 排序');
	});

	it('does not link std:: qualified names inside inline code', () => {
		const refs = [makeRef({ uri: 'file:///main.cpp', label: 'main.cpp', symbol: 'sort' })];
		assert.strictEqual(
			inferenceLinkifyAnswer('用 `std::sort` 排序', refs),
			'用 `std::sort` 排序'
		);
	});

	it('links qualified names by a unique last segment', () => {
		const refs = [makeRef({ uri: 'file:///monster.h', label: 'monster.h', symbol: 'takeTurn' })];
		assert.strictEqual(
			inferenceLinkifyAnswer('这是 `Monster::takeTurn` 函数', refs),
			'这是 [`Monster::takeTurn`](classmate-ref://0?i) 函数'
		);
	});

	it('does not link qualified names whose last segment is ambiguous', () => {
		const refs = [
			makeRef({ uri: 'file:///player.h', label: 'player.h', symbol: 'printStatus' }),
			makeRef({ uri: 'file:///monster.h', label: 'monster.h', symbol: 'printStatus' }),
		];
		assert.strictEqual(
			inferenceLinkifyAnswer('`Player::printStatus` 方法', refs),
			'`Player::printStatus` 方法'
		);
	});

	it('never links multi-object inline code like calls with arguments (用户边界)', () => {
		const refs = [
			makeRef({ uri: 'file:///main.cpp', label: 'main.cpp', symbol: 'playCard' }),
			makeRef({ uri: 'file:///card.h', label: 'card.h', symbol: 'players' }),
		];
		const out = inferenceLinkifyAnswer('看 `players[i].playCard(c)` 和 `sort(a, n)`', refs);
		assert.strictEqual(out, '看 `players[i].playCard(c)` 和 `sort(a, n)`');
	});

	it('keeps marker-generated links untouched and skips code blocks / other links', () => {
		const refs = [makeRef({ uri: 'file:///main.cpp', label: 'main.cpp', symbol: 'sort' })];
		const content = [
			'```cpp',
			'sort(a, n);',
			'```',
			'模型标记的 [`sort`](classmate-ref://0) 保持原样,这里再提 `sort`。',
			'代码段 `sort(a, n);` 不链,详见 [sort 文档](https://example.com)。',
		].join('\n');
		const out = inferenceLinkifyAnswer(content, refs);
		assert.ok(out.includes('```cpp\nsort(a, n);\n```'), '代码块内不链接');
		assert.ok(out.includes('[`sort`](classmate-ref://0) '), '已有标记链接不被二次包装');
		assert.ok(out.includes('[`sort`](classmate-ref://0?i)。'), '未标记的行内代码补 inferred 链接');
		assert.ok(out.includes('`sort(a, n);`'), '非单一标识符的行内代码保持代码样式');
		assert.ok(out.includes('[sort 文档](https://example.com)'), '外部链接不修改');
	});
});

describe('summarizeReferenceLayers', () => {
	it('counts model-marked and inferred links separately', () => {
		const markdown = [
			'看 [`takeTurn`](classmate-ref://0) 与补的 [`sort`](classmate-ref://1?i),',
			'再补一个 [`sort`](classmate-ref://1?i)。',
		].join('');
		assert.deepStrictEqual(summarizeReferenceLinks(markdown), {
			modelMarkedLinks: 1,
			inferredLinks: 2,
		});
	});
});

describe('transformReferenceUrl (inferred suffix)', () => {
	it('preserves classmate-ref links including the inferred suffix', () => {
		assert.strictEqual(transformReferenceUrl('classmate-ref://0?i'), 'classmate-ref://0?i');
	});
});
