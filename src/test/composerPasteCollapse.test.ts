import * as assert from 'assert';
import { describe, it } from 'mocha';
import {
	buildPasteToken,
	countLines,
	expandPasteTokens,
	findActivePasteTokens,
	findBrokenPasteFragments,
	findRemovedPasteTokens,
	findUniquePasteSerial,
	parsePasteToken,
	PASTE_COLLAPSE_MIN_CHARS,
	PASTE_COLLAPSE_MIN_LINES,
	shouldCollapsePaste,
} from '../chat/composerPasteCollapse';

function lines(n: number): string {
	const body = Array.from({ length: n }, (_, i) => `第${i + 1}行内容`);
	return `${body.join('\n')}\n`;
}

describe('composer paste collapse: thresholds', () => {
	it('never collapses empty text', () => {
		assert.strictEqual(shouldCollapsePaste(''), false);
	});

	it('does not collapse short text below both thresholds', () => {
		assert.strictEqual(shouldCollapsePaste('帮我看看这段代码'), false);
		assert.strictEqual(shouldCollapsePaste(lines(PASTE_COLLAPSE_MIN_LINES - 1)), false);
		assert.strictEqual(shouldCollapsePaste('a'.repeat(PASTE_COLLAPSE_MIN_CHARS - 1)), false);
	});

	it('collapses at exactly the line threshold', () => {
		assert.strictEqual(shouldCollapsePaste(lines(PASTE_COLLAPSE_MIN_LINES)), true);
	});

	it('collapses a single line at exactly the char threshold', () => {
		const singleLine = 'x'.repeat(PASTE_COLLAPSE_MIN_CHARS);
		assert.strictEqual(countLines(singleLine), 1);
		assert.strictEqual(shouldCollapsePaste(singleLine), true);
	});
});

describe('composer paste collapse: countLines', () => {
	it('returns 0 for empty text', () => {
		assert.strictEqual(countLines(''), 0);
	});

	it('counts single line without trailing newline', () => {
		assert.strictEqual(countLines('int main() {}'), 1);
	});

	it('does not count a single trailing newline as an extra line', () => {
		assert.strictEqual(countLines('a\nb\nc\n'), 3);
		assert.strictEqual(countLines('a\n'), 1);
	});

	it('counts CRLF content by LF boundaries', () => {
		assert.strictEqual(countLines('a\r\nb\r\nc'), 3);
	});
});

describe('composer paste collapse: token build & parse', () => {
	it('builds the documented token shape', () => {
		assert.strictEqual(buildPasteToken(1, 12), '[已粘贴 #1 12 行]');
		assert.strictEqual(buildPasteToken(23, 345), '[已粘贴 #23 345 行]');
	});

	it('round-trips through parsePasteToken', () => {
		const token = buildPasteToken(7, 42);
		assert.deepStrictEqual(parsePasteToken(token), { serial: 7, lineCount: 42 });
	});

	it('rejects malformed token strings', () => {
		assert.strictEqual(parsePasteToken('[已粘贴 #1 12 行'), undefined);
		assert.strictEqual(parsePasteToken('[已粘贴 1 12 行]'), undefined);
		assert.strictEqual(parsePasteToken('[已粘贴 #a 12 行]'), undefined);
		assert.strictEqual(parsePasteToken('已粘贴 #1 12 行]'), undefined);
		assert.strictEqual(parsePasteToken(''), undefined);
	});
});

describe('composer paste collapse: unique serial selection', () => {
	it('keeps the desired serial when nothing conflicts', () => {
		assert.strictEqual(findUniquePasteSerial(() => false, 1, 12), 1);
	});

	it('skips serials whose token is already taken', () => {
		const taken = new Set(['[已粘贴 #1 12 行]', '[已粘贴 #2 12 行]']);
		assert.strictEqual(
			findUniquePasteSerial((token) => taken.has(token), 1, 12),
			3
		);
	});

	it('starts from at least 1 even with a zero desired serial', () => {
		assert.strictEqual(findUniquePasteSerial(() => false, 0, 5), 1);
	});
});

describe('composer paste collapse: active token scan', () => {
	it('finds tokens in first-appearance order and deduplicates', () => {
		const value = `前缀 [已粘贴 #2 9 行] 中间 [已粘贴 #1 20 行] 再次 [已粘贴 #2 9 行]`;
		assert.deepStrictEqual(findActivePasteTokens(value), [
			'[已粘贴 #2 9 行]',
			'[已粘贴 #1 20 行]',
		]);
	});

	it('returns empty for values without tokens', () => {
		assert.deepStrictEqual(findActivePasteTokens('普通文字'), []);
		assert.deepStrictEqual(findActivePasteTokens('[已粘贴 #1 12 行'), []);
	});
});

describe('composer paste collapse: send-time expansion', () => {
	const map = new Map<string, string>([
		['[已粘贴 #1 12 行]', 'line-A\nline-B'],
		['[已粘贴 #2 3 行]', 'console.log(1);'],
	]);

	it('expands a token to the verbatim original content', () => {
		const result = expandPasteTokens('看看这个 [已粘贴 #1 12 行] 谢谢', (t) => map.get(t));
		assert.strictEqual(result.text, '看看这个 line-A\nline-B 谢谢');
		assert.deepStrictEqual(result.missingTokens, []);
	});

	it('expands multiple tokens including repeats', () => {
		const result = expandPasteTokens('[已粘贴 #1 12 行]\n对照:\n[已粘贴 #2 3 行]\n再看 [已粘贴 #1 12 行]', (t) => map.get(t));
		assert.strictEqual(
			result.text,
			'line-A\nline-B\n对照:\nconsole.log(1);\n再看 line-A\nline-B'
		);
		assert.deepStrictEqual(result.missingTokens, []);
	});

	it('keeps unmapped tokens verbatim and reports them as missing', () => {
		const result = expandPasteTokens('开头 [已粘贴 #9 4 行] [已粘贴 #1 12 行]', (t) => map.get(t));
		assert.strictEqual(result.text, '开头 [已粘贴 #9 4 行] line-A\nline-B');
		assert.deepStrictEqual(result.missingTokens, ['[已粘贴 #9 4 行]']);
	});

	it('reports repeated missing tokens only once', () => {
		const result = expandPasteTokens('[已粘贴 #9 4 行] [已粘贴 #9 4 行]', () => undefined);
		assert.deepStrictEqual(result.missingTokens, ['[已粘贴 #9 4 行]']);
	});
});

describe('composer paste collapse: removal diff', () => {
	it('detects tokens removed between two values', () => {
		const previous = '[已粘贴 #1 12 行] 加上 [已粘贴 #2 3 行]';
		const current = '加上 [已粘贴 #2 3 行]';
		assert.deepStrictEqual(findRemovedPasteTokens(previous, current), ['[已粘贴 #1 12 行]']);
	});

	it('returns empty when nothing was removed', () => {
		assert.deepStrictEqual(findRemovedPasteTokens('a [已粘贴 #1 2 行]', 'b [已粘贴 #1 2 行] [已粘贴 #3 4 行]'), []);
		assert.deepStrictEqual(findRemovedPasteTokens('', '[已粘贴 #1 2 行]'), []);
	});
});

describe('composer paste collapse: broken fragments', () => {
	it('does not flag valid tokens', () => {
		assert.deepStrictEqual(findBrokenPasteFragments('[已粘贴 #1 12 行] 正常'), []);
	});

	it('flags a token with the closing bracket deleted', () => {
		const fragments = findBrokenPasteFragments('[已粘贴 #1 12 行');
		assert.strictEqual(fragments.length, 1);
		assert.ok(fragments[0].startsWith('[已粘贴'));
	});

	it('flags a half-deleted token', () => {
		const fragments = findBrokenPasteFragments('前 [已粘贴 #1 1');
		assert.strictEqual(fragments.length, 1);
	});

	it('flags stray prefix text that only looks like a token', () => {
		assert.strictEqual(findBrokenPasteFragments('[已粘贴 ]').length, 1);
	});

	it('flags broken fragments around a valid token but not the valid token itself', () => {
		const fragments = findBrokenPasteFragments('[已粘贴 #1 1 [已粘贴 #2 3 行] 尾');
		assert.strictEqual(fragments.length, 1);
		assert.ok(fragments[0].startsWith('[已粘贴 #1'));
	});
});
