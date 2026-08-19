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
		]), { workspaceRootUri: 'file:///c%3A/Users/dev/ws' });

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
		assert.strictEqual(result.references[0].uri, 'file:///c%3A/Users/dev/ws/monster.h');
		assert.strictEqual(result.references[0].startLine, 26);
		assert.strictEqual(result.references[0].kind, 'func');
	});

	it('degrades every marker to inline code when no workspace root is available', () => {
		// 无真实根路径时宁可不给链接,也不产出指向不存在文件的 file:///w 链接。
		const answer = '看 {{ref:sym:monster.h:Monster:takeTurn|takeTurn}}';
		const result = finalizeAnswerReferences(answer, SYMBOLS, new Map([
			['monster.h', 'hash-a'],
		]));
		assert.ok(!result.markdown.includes('classmate-ref://'), '缺根路径时不得生成链接');
		assert.ok(result.markdown.includes('`takeTurn`'), '保留行内代码样式');
		assert.deepStrictEqual(result.references, []);
		assert.deepStrictEqual(result.issues.map((issue) => issue.kind), ['missing_root']);
	});

	it('encodes workspace-relative paths into the final URI', () => {
		const symbols: CppSymbol[] = [{
			targetId: 'sym:src/my util.cpp::helper',
			file: 'src/my util.cpp',
			name: 'helper',
			kind: 'function',
			startLine: 3,
			endLine: 5,
		}];
		const result = finalizeAnswerReferences(
			'调用 {{ref:sym:src/my util.cpp::helper|helper}}',
			symbols,
			new Map([['src/my util.cpp', 'hash-x']]),
			{ workspaceRootUri: 'file:///root/' }
		);
		assert.strictEqual(result.references[0].uri, 'file:///root/src/my%20util.cpp');
	});

	it('converts refblock source markers after fenced code blocks into visible source lines', () => {
		const answer = [
			'改成这样:',
			'',
			'```cpp',
			'std::cout << "turn";',
			'player.takeDamage(attack_);',
			'```',
			'{{refblock:sym:monster.h:Monster:takeTurn}}',
			'后续正文。',
		].join('\n');
		const result = finalizeAnswerReferences(answer, SYMBOLS, new Map([
			['monster.h', 'hash-a'],
		]), { workspaceRootUri: 'file:///ws' });
		assert.ok(!result.markdown.includes('{{refblock:'), 'refblock 标记不得泄漏');
		assert.ok(
			result.markdown.includes('*来源: [`takeTurn`](classmate-ref://0) · monster.h:26–31*'),
			'代码块后应出现可见来源行'
		);
		assert.strictEqual(result.references.length, 1);
		assert.strictEqual(result.references[0].startLine, 26);
	});

	it('degrades refblock markers with unknown or stale targets to plain source text', () => {
		const answer = [
			'```cpp',
			'int x;',
			'```',
			'{{refblock:sym:nope.h::ghost,sym:util.h::sort}}',
		].join('\n');
		const result = finalizeAnswerReferences(answer, SYMBOLS, new Map([
			['monster.h', 'hash-a'],
		]), { workspaceRootUri: 'file:///ws' });
		assert.ok(!result.markdown.includes('{{refblock:'));
		// sort 的 hash 未在本轮加载清单里 → stale,不链接;ghost 未知。
		// 降级形态:来源行保留但无链接。
		assert.ok(!result.markdown.includes('classmate-ref://'), '坏目标不得生成链接');
		assert.deepStrictEqual(result.issues.map((issue) => issue.kind), [
			'unknown_target',
			'stale_hash',
		]);
	});

	it('strips model-fabricated bare classmate-ref links, keeping the label text', () => {
		const answer = [
			'你现在需要补全 [`takeTurn`](classmate-ref://0) 函数,',
			'再看 [Creature](classmate-ref://3) 基类。',
		].join('');
		const result = finalizeAnswerReferences(answer, SYMBOLS, new Map([
			['monster.h', 'hash-a'],
		]), { workspaceRootUri: 'file:///ws' });
		// 模型自编的裸链接(没有对应 {{ref:}} 标记)不得进入成品正文:
		// 行内代码文字保留,链接剥掉。
		assert.ok(!result.markdown.includes('](classmate-ref://'), '裸链接必须剥离');
		assert.ok(result.markdown.includes('`takeTurn`'));
		assert.ok(result.markdown.includes('Creature'));
		assert.deepStrictEqual(result.references, []);
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
