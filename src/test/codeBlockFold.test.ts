import * as assert from 'assert';
import { describe, it } from 'mocha';
import {
	CODE_FOLD_COLLAPSE_THRESHOLD,
	CODE_FOLD_PREVIEW_LINES,
	planCodeBlockFold,
} from '../chat/codeBlockFold';

function makeCode(lineCount: number): string {
	return Array.from({ length: lineCount }, (_, i) => `int line${i + 1} = ${i + 1};`).join('\n');
}

describe('planCodeBlockFold (代码块折叠决策)', () => {
	it('阈值常量为 12 行/预览 8 行(锁默认值,防无意识改动)', () => {
		assert.strictEqual(CODE_FOLD_COLLAPSE_THRESHOLD, 12);
		assert.strictEqual(CODE_FOLD_PREVIEW_LINES, 8);
	});

	it('不超过阈值的代码块不折叠,previewText 即整段代码', () => {
		const code = makeCode(12);
		const plan = planCodeBlockFold(code);
		assert.strictEqual(plan.shouldCollapse, false);
		assert.strictEqual(plan.totalLines, 12);
		assert.strictEqual(plan.previewText, code);
		assert.strictEqual(plan.hiddenLineCount, 0);
	});

	it('超过阈值(13 行)触发折叠', () => {
		const plan = planCodeBlockFold(makeCode(13));
		assert.strictEqual(plan.shouldCollapse, true);
		assert.strictEqual(plan.totalLines, 13);
	});

	it('折叠时 previewText 为前 8 行,hiddenLineCount 为其余行数', () => {
		const code = makeCode(20);
		const plan = planCodeBlockFold(code);
		assert.strictEqual(plan.shouldCollapse, true);
		const previewLines = plan.previewText.split('\n');
		assert.strictEqual(previewLines.length, CODE_FOLD_PREVIEW_LINES);
		assert.strictEqual(previewLines[0], 'int line1 = 1;');
		assert.strictEqual(previewLines[7], 'int line8 = 8;');
		assert.strictEqual(plan.hiddenLineCount, 12);
	});

	it('尾部换行(单个/多个)不计数、不影响 previewText', () => {
		const plan = planCodeBlockFold(makeCode(13) + '\n');
		assert.strictEqual(plan.totalLines, 13);
		const multi = planCodeBlockFold(makeCode(13) + '\n\n\n');
		assert.strictEqual(multi.totalLines, 13);
	});

	it('CRLF 归一为 LF 后再计行', () => {
		const plan = planCodeBlockFold(makeCode(13).split('\n').join('\r\n'));
		assert.strictEqual(plan.totalLines, 13);
		assert.strictEqual(plan.shouldCollapse, true);
	});

	it('空串与单行代码不折叠', () => {
		assert.deepStrictEqual(
			{ ...planCodeBlockFold('') },
			{ totalLines: 1, shouldCollapse: false, previewText: '', hiddenLineCount: 0 }
		);
		const one = planCodeBlockFold('int x = 0;');
		assert.strictEqual(one.shouldCollapse, false);
		assert.strictEqual(one.totalLines, 1);
	});

	it('同输入恒同输出(确定性,重复调用逐字段一致)', () => {
		const code = makeCode(30);
		const a = planCodeBlockFold(code);
		const b = planCodeBlockFold(code);
		assert.deepStrictEqual(a, b);
	});
});
