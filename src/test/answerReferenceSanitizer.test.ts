import * as assert from 'assert';
import { describe, it } from 'mocha';
import {
	hasCallLike,
	hasDefinitionLike,
	hasSymbolNearLine,
	hasSymbolOnLine,
	sanitizeAnswerReferences,
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

	it('helpers detect definition/call/near-line occurrences', () => {
		assert.ok(hasDefinitionLike(MAIN_CPP.content, 'sort'));
		assert.ok(hasCallLike(MAIN_CPP.content, 'sort'));
		assert.ok(hasSymbolNearLine(MAIN_CPP.content, 'sort', 4));
		assert.ok(hasSymbolNearLine(LONG_FILE.content, 'foo', 3));
		assert.ok(!hasSymbolNearLine(LONG_FILE.content, 'foo', 10));
		assert.ok(hasSymbolOnLine(MAIN_CPP.content, 'sort', 2));
		assert.ok(!hasSymbolOnLine(MAIN_CPP.content, 'sort', 3));
	});
});
