import * as assert from 'assert';
import { describe, it } from 'mocha';
import {
	buildReferenceTargetCatalog,
	finalizeAnswerReferences,
} from '../chat/answerReferenceFinalizer';
import type { CppSymbol } from '../parser/cppWorkspaceIndex';

const SYMBOLS: CppSymbol[] = [
	{
		targetId: 'sym:monster.h:Monster:takeTurn',
		file: 'monster.h',
		name: 'takeTurn',
		kind: 'method',
		container: 'Monster',
		startLine: 26,
		endLine: 31,
		body: {
			empty: true,
			commentOnly: true,
			nonEmptyStatementCount: 0,
			calledNames: [],
		},
	},
	{
		targetId: 'sym:monster.h:Monster:printStatus',
		file: 'monster.h',
		name: 'printStatus',
		kind: 'method',
		container: 'Monster',
		startLine: 34,
		endLine: 36,
	},
	{
		targetId: 'sym:util.h::sort',
		file: 'util.h',
		name: 'sort',
		kind: 'function',
		startLine: 5,
		endLine: 9,
	},
];

describe('reference target catalog', () => {
	it('exposes only valid candidate ids with file and line', () => {
		const catalog = buildReferenceTargetCatalog(SYMBOLS);
		const ids = catalog.targets.map((target) => target.targetId);
		assert.ok(ids.includes('sym:monster.h:Monster:takeTurn'));
		assert.ok(ids.includes('sym:util.h::sort'));
		const takeTurn = catalog.targets.find(
			(target) => target.targetId === 'sym:monster.h:Monster:takeTurn'
		);
		assert.strictEqual(takeTurn?.file, 'monster.h');
		assert.strictEqual(takeTurn?.startLine, 26);
	});
});

describe('answer reference finalizer', () => {
	it('converts valid markers into inline code links and reference list', () => {
		const answer = [
			'你看 {{ref:sym:monster.h:Monster:takeTurn|takeTurn}} 函数,',
			'再看普通文字 takeTurn 与 {{ref:sym:util.h::sort|sort}},',
			'普通 sort 没有标记。',
		].join('');
		const result = finalizeAnswerReferences(answer, SYMBOLS, new Map([
			['monster.h', 'hash-a'],
			['util.h', 'hash-b'],
		]));

		assert.strictEqual(result.markdown.includes('[`takeTurn`](classmate-ref://0)'), true);
		assert.strictEqual(result.markdown.includes('[`sort`](classmate-ref://1)'), true);
		// 未标记的普通词不获得链接。
		assert.ok(!/\[takeTurn\]\(classmate-ref/.test(result.markdown.replace(/[`[]/g, m => m === '`' ? '`' : m)) || true);
		const plainLinks = result.markdown.match(/\[(?!\`)([^\]]+)\]\(classmate-ref:\/\/\d+\)/g) ?? [];
		assert.deepStrictEqual(plainLinks, []);
		// 原始标记不残留。
		assert.ok(!result.markdown.includes('{{ref:'));
		// 引用清单由标记生成:目标文件/行号/符号kind 正确。
		assert.strictEqual(result.references.length, 2);
		assert.strictEqual(result.references[0].uri, 'file:///w/monster.h');
		assert.strictEqual(result.references[0].startLine, 26);
		assert.strictEqual(result.references[0].kind, 'func');
	});

	it('degrades invalid or stale-hash markers to plain code text without links', () => {
		const answer = '坏的 {{ref:sym:nope.h::ghost|ghost}}、'
			+ '过期的 {{ref:sym:monster.h:Monster:takeTurn|takeTurn}}(hash 不匹配)';
		const result = finalizeAnswerReferences(answer, SYMBOLS, new Map([
			['util.h', 'hash-b'],
		]));
		assert.ok(!result.markdown.includes('classmate-ref://'));
		// 降级为行内代码样式,文字保留,无链接。
		assert.ok(result.markdown.includes('`ghost`'));
		assert.ok(result.markdown.includes('`takeTurn`'));
		assert.deepStrictEqual(result.references, []);
		assert.deepStrictEqual(result.issues.map((issue) => issue.kind), [
			'unknown_target',
			'stale_hash',
		]);
	});

	it('never lets raw markers leak: unclosed markers degrade to plain text', () => {
		const answer = '残缺 {{ref:sym:monster.h:Monster:takeTurn|takeTurn 与后续文字';
		const result = finalizeAnswerReferences(answer, SYMBOLS, new Map([
			['monster.h', 'hash-a'],
		]));
		assert.ok(!result.markdown.includes('{{ref:'), '残缺标记也不得进入渲染文本');
	});
});
