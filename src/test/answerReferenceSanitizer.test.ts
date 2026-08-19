import * as assert from 'assert';
import { describe, it } from 'mocha';
import {
	buildReferenceExtractionInput,
	hasCallLike,
	hasDefinitionLike,
	hasSymbolNearLine,
	hasSymbolOnLine,
	inferSymbolKind,
	sanitizeAnswerReferences,
	stripContractNotation,
	scanSymbols,
	type ExtractedReference,
} from '../chat/answerReferenceSanitizer';
import type { LoadedWorkspaceItem } from '../workspace/types';

function makeItem(path: string, content: string): LoadedWorkspaceItem {
	return { path, kind: 'code', content, contentHash: 'h', reason: 'test' };
}

const MAIN_CPP = makeItem(
	'main.cpp',
	[
		'#include <iostream>',
		'void sort(int* a, int n) {',
		'  for (int i = 0; i < n; i++) {',
		'    // bubble',
		'  }',
		'}',
		'int main() {',
		'  sort(data, 5);',
		'  return 0;',
		'}',
	].join('\n')
);

const LONG_FILE = makeItem(
	'long.cpp',
	Array.from({ length: 20 }, (_, index) =>
		index === 0 ? 'void foo() {}' : `int x${index} = ${index};`
	).join('\n')
);

describe('answerReferenceSanitizer', () => {
	it('drops candidates whose file is not in the loaded whitelist', () => {
		const candidates: ExtractedReference[] = [{ f: 'helper.cpp', s: 'sort' }];
		const result = sanitizeAnswerReferences(candidates, [MAIN_CPP]);
		assert.deepStrictEqual(result, []);
	});

	it('drops symbols that do not exist in the file', () => {
		const candidates: ExtractedReference[] = [{ f: 'main.cpp', s: 'nonexistentFunc' }];
		const result = sanitizeAnswerReferences(candidates, [MAIN_CPP]);
		assert.deepStrictEqual(result, []);
	});

	it('clamps line numbers into range', () => {
		// 9999 clamp 到 20 行后,±5 窗口(15-20 行)内没有 foo → 行号回退为 undefined。
		const candidates: ExtractedReference[] = [{ f: 'long.cpp', s: 'foo', l: 9999 }];
		const result = sanitizeAnswerReferences(candidates, [LONG_FILE]);
		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0].l, undefined);
		assert.strictEqual(result[0].s, 'foo');
	});

	it('keeps the line only when the symbol is exactly on it', () => {
		const candidates: ExtractedReference[] = [{ f: 'main.cpp', s: 'sort', l: 2 }];
		const result = sanitizeAnswerReferences(candidates, [MAIN_CPP]);
		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0].l, 2);

		// 第 3 行没有 sort,精确校验不过 → 行号回退。
		const nearby: ExtractedReference[] = [{ f: 'main.cpp', s: 'sort', l: 3 }];
		const nearbyResult = sanitizeAnswerReferences(nearby, [MAIN_CPP]);
		assert.strictEqual(nearbyResult[0].l, undefined);
	});

	it('validates kind: def requires a definition-like occurrence, call requires a call site', () => {
		const defCandidate: ExtractedReference[] = [{ f: 'main.cpp', s: 'sort', k: 'def' }];
		const defResult = sanitizeAnswerReferences(defCandidate, [MAIN_CPP]);
		assert.strictEqual(defResult[0].k, 'def');

		const callCandidate: ExtractedReference[] = [{ f: 'main.cpp', s: 'sort', k: 'call' }];
		const callResult = sanitizeAnswerReferences(callCandidate, [MAIN_CPP]);
		assert.strictEqual(callResult[0].k, 'call');

		// sort 在第 8 行被调用,但文件里也有定义;kind=call 仍有效(存在调用)。
		const falseDef: ExtractedReference[] = [{ f: 'main.cpp', s: 'data', k: 'def' }];
		const falseDefResult = sanitizeAnswerReferences(falseDef, [MAIN_CPP]);
		// data 只有引用没有定义形态,kind 应被回退为 undefined。
		assert.strictEqual(falseDefResult[0].k, undefined);
	});

	it('drops candidates with neither symbol nor line', () => {
		const candidates: ExtractedReference[] = [{ f: 'main.cpp' }];
		const result = sanitizeAnswerReferences(candidates, [MAIN_CPP]);
		assert.deepStrictEqual(result, []);
	});

	it('deduplicates identical references', () => {
		const candidates: ExtractedReference[] = [
			{ f: 'main.cpp', s: 'sort', l: 2 },
			{ f: 'main.cpp', s: 'sort', l: 2 },
		];
		const result = sanitizeAnswerReferences(candidates, [MAIN_CPP]);
		assert.strictEqual(result.length, 1);
	});

	it('scanSymbols collects callable names and excludes control keywords', () => {
		const symbols = scanSymbols(MAIN_CPP.content);
		assert.ok(symbols.includes('sort'));
		assert.ok(!symbols.includes('for'));
		assert.ok(!symbols.includes('return'));
	});

	it('scanSymbols excludes single-character symbols', () => {
		const symbols = scanSymbols('void foo(int a, int n) { a(n); }');
		assert.ok(!symbols.includes('a'));
		assert.ok(!symbols.includes('n'));
		assert.ok(symbols.includes('foo'));
	});

	it('buildReferenceExtractionInput only includes code files', () => {
		const input = buildReferenceExtractionInput([
			makeItem('main.cpp', 'void foo() {}'),
			{ ...makeItem('README.md', 'Strike (1 energy)'), kind: 'text' },
		]);
		assert.deepStrictEqual(
			input.map((file) => file.path),
			['main.cpp']
		);
	});

	it('scanSymbols collects class/struct/enum type names but not template params', () => {
		const content = [
			'class Player : public Creature {',
			'struct Node {',
			'enum Color { RED };',
			'enum class Kind { A };',
			'template<class T> void foo(T x) {}',
		].join('\n');
		const symbols = scanSymbols(content);
		assert.ok(symbols.includes('Player'));
		assert.ok(symbols.includes('Node'));
		assert.ok(symbols.includes('Color'));
		assert.ok(symbols.includes('Kind'));
		assert.ok(!symbols.includes('T'), 'template<class T> 里的 T 不应被当成类型名');
	});

	it('hasDefinitionLike recognizes class definitions', () => {
		assert.ok(hasDefinitionLike('class Player {', 'Player'));
		assert.ok(hasDefinitionLike('struct Node : Base {', 'Node'));
		assert.ok(hasDefinitionLike('enum class Kind {', 'Kind'));
		assert.ok(!hasDefinitionLike('int x = 0;', 'Player'));
	});

	it('helpers detect definition/call/near-line occurrences', () => {
		assert.ok(hasDefinitionLike(MAIN_CPP.content, 'sort'));
		assert.ok(hasCallLike(MAIN_CPP.content, 'sort'));
		assert.ok(hasSymbolNearLine(MAIN_CPP.content, 'sort', 4));
		assert.ok(hasSymbolNearLine(LONG_FILE.content, 'foo', 3));
		assert.ok(!hasSymbolNearLine(LONG_FILE.content, 'foo', 10));
		assert.ok(hasSymbolOnLine(MAIN_CPP.content, 'sort', 2));
		assert.ok(!hasSymbolOnLine(MAIN_CPP.content, 'sort', 3));
	});

	it('inferSymbolKind: 本地高置信证据优先于 LLM 提议', () => {
		assert.strictEqual(inferSymbolKind(MAIN_CPP.content, 'sort', 'var'), 'func');
		assert.strictEqual(inferSymbolKind(MAIN_CPP.content, 'main', 'other'), 'func');
		assert.strictEqual(inferSymbolKind('class Player {', 'Player', 'var'), 'type');
		assert.strictEqual(inferSymbolKind('struct Node : Base {', 'Node', 'var'), 'type');
		assert.strictEqual(inferSymbolKind('enum class Kind {', 'Kind', 'func'), 'type');
		assert.strictEqual(inferSymbolKind('#define MAX_SIZE 100', 'MAX_SIZE', 'var'), 'macro');
		assert.strictEqual(inferSymbolKind('int count = 0;', 'count', 'var'), 'var');
		assert.strictEqual(inferSymbolKind('int count = 0;', 'count'), 'other');
	});

	it('inferSymbolKind: 构造函数初始化列表里的成员初始化不算函数调用', () => {
		const content = [
			'class Player {',
			'  int energy_;',
			'  Player(int e) : energy_(e) {}',
			'  void play() { std::cout << energy_; }',
			'};',
		].join('\n');
		assert.ok(!hasCallLike(content, 'energy_'));
		assert.strictEqual(inferSymbolKind(content, 'energy_'), 'var');
		assert.strictEqual(inferSymbolKind('int attack_;', 'attack_', 'other'), 'var');
	});

	it('sanitizeAnswerReferences 输出语义类型 t', () => {
		const candidates: ExtractedReference[] = [
			{ f: 'main.cpp', s: 'sort', t: 'var' }, // 本地定义证据覆盖 LLM 提议
			{ f: 'main.cpp', s: 'data', t: 'var' }, // 无本地证据,保留 LLM 提议
			{ f: 'main.cpp', s: 'main' }, // 无提议,本地推出 func
		];
		const result = sanitizeAnswerReferences(candidates, [MAIN_CPP]);
		assert.strictEqual(result[0].t, 'func');
		assert.strictEqual(result[1].t, 'var');
		assert.strictEqual(result[2].t, 'func');
	});

	it('sanitize 将未提议的成员变量判为 var', () => {
		const item = makeItem('monster.h', [
			'class Monster {',
			'  int attack_;',
			'  Monster(int a) : attack_(a) {}',
			'  void takeTurn() { std::cout << attack_; }',
			'};',
		].join('\n'));
		const result = sanitizeAnswerReferences([{ f: 'monster.h', s: 'attack_' }], [item]);
		assert.strictEqual(result[0].t, 'var');
	});

	it('buildReferenceExtractionInput filters symbols not mentioned in the answer', () => {
		const input = buildReferenceExtractionInput([MAIN_CPP], 'sort 函数的时间复杂度是多少');
		assert.strictEqual(input.length, 1);
		const names = input[0].symbols.map((symbol) => symbol.name);
		assert.ok(names.includes('sort'));
		assert.ok(!names.includes('main'), '回答没提 main,不应出现在清单里');
	});

	it('caps probed lines per symbol at MAX_LINES_PER_SYMBOL', () => {
		const content = Array.from(
			{ length: 10 },
			(_, index) => `int r${index} = helper(${index});`
		).join('\n');
		const input = buildReferenceExtractionInput(
			[makeItem('a.cpp', content)],
			'helper 被调用了'
		);
		const helper = input[0].symbols.find((symbol) => symbol.name === 'helper');
		assert.ok(helper);
		assert.ok(helper!.lines.length <= 6, `probed too many lines: ${helper!.lines.length}`);
	});

	it('truncates long line text to MAX_LINE_TEXT_LENGTH', () => {
		const longLine = `int helper(int a) { return a + ${'x'.repeat(160)}; }`;
		const input = buildReferenceExtractionInput(
			[makeItem('a.cpp', `${longLine}\nint main() { return helper(1); }`)],
			'helper 函数'
		);
		const helper = input[0].symbols.find((symbol) => symbol.name === 'helper');
		assert.ok(helper);
		const line = helper!.lines[0];
		assert.ok(line.text.length <= 101, `line text too long: ${line.text.length}`);
		assert.ok(line.text.endsWith('…'));
	});
});

describe('contract marker defense (旧提取路径防御)', () => {
	it('strips {{ref:}} markers and classmate-ref link tails from the answer before extraction', () => {
		const answer = [
			'你看 {{ref:sym:monster.h:Monster:takeTurn|takeTurn}} 函数,',
			'再看 [`sort`](classmate-ref://0) 与补链 [`sort`](classmate-ref://1?i),',
			'普通文字 sort 保留。',
		].join('');
		const cleaned = stripContractNotation(answer);
		assert.ok(!cleaned.includes('{{ref:'));
		assert.ok(!cleaned.includes('classmate-ref://'));
		assert.strictEqual(cleaned, '你看 `takeTurn` 函数,再看 `sort` 与补链 `sort`,普通文字 sort 保留。');
	});

	it('returns plain answers unchanged', () => {
		const answer = '看看 sort 的第 3 行,行内代码 `sort(a, n);` 原样保留。';
		assert.strictEqual(stripContractNotation(answer), answer);
	});
});

	it('strips refblock markers and rendered source lines too', () => {
		const answer = [
			'```cpp',
			'int x;',
			'```',
			'*来源: [`takeTurn`](classmate-ref://0) · monster.h:26–31*',
			'{{refblock:sym:monster.h:Monster:takeTurn}}',
			'正文 `takeTurn` 保留。',
		].join('\n');
		const cleaned = stripContractNotation(answer);
		assert.ok(!cleaned.includes('*来源:'));
		assert.ok(!cleaned.includes('{{refblock:'));
		assert.ok(!cleaned.includes('classmate-ref://'));
		assert.ok(cleaned.includes('正文 `takeTurn` 保留。'));
	});
