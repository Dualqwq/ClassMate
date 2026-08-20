import * as assert from 'assert';
import { describe, it } from 'mocha';
import { buildRecoveryLocalHint } from '../chat/answerRecoveryHint';
import type { CppSymbol } from '../parser/cppWorkspaceIndex';

function symbol(partial: Partial<CppSymbol> & Pick<CppSymbol, 'name' | 'file' | 'startLine'>): CppSymbol {
	return {
		targetId: `sym:${partial.file}::${partial.name}`,
		kind: 'method',
		endLine: partial.startLine + 4,
		...partial,
	};
}

describe('answerRecoveryHint (7.8 恢复兜底本地事实提示)', () => {
	it('列出符号的确定性事实:空体/仅注释/激活各按事实措辞', () => {
		const hint = buildRecoveryLocalHint({
			symbols: [
				symbol({
					name: 'takeTurn', file: 'monster.h', startLine: 26,
					body: { empty: true, commentOnly: false, nonEmptyStatementCount: 0, calledNames: [] },
				}),
				symbol({
					name: 'printStatus', file: 'monster.h', startLine: 34,
					body: { empty: false, commentOnly: false, nonEmptyStatementCount: 1, calledNames: [] },
				}),
			],
		});
		assert.ok(hint.includes('抱歉'), '须含道歉措辞');
		assert.ok(hint.includes('monster.h 第 26–30 行'), '须带行范围');
		assert.ok(hint.includes('函数体为空'), '空体符号按事实措辞');
		assert.ok(hint.includes('非空语句 1 句'), '激活符号带语句数');
		assert.ok(!/(Frozen workspace data|清单|信封|校验|grounding)/.test(hint), '不得出现内部术语');
	});

	it('仅注释符号按"只有注释"措辞,与激活符号区分', () => {
		const hint = buildRecoveryLocalHint({
			symbols: [
				symbol({
					name: 'takeTurn', file: 'monster.h', startLine: 26,
					body: { empty: false, commentOnly: true, nonEmptyStatementCount: 0, calledNames: [] },
				}),
			],
		});
		assert.ok(hint.includes('只有注释,没有实际代码'));
		assert.ok(!hint.includes('已有实际代码'));
	});

	it('无符号索引时退化为引导核对当前文件的短提示', () => {
		const hint = buildRecoveryLocalHint({ activeFile: 'monster.h' });
		assert.ok(hint.includes('monster.h'));
		assert.ok(hint.includes('抱歉'));
		assert.ok(!hint.includes('第'), '无索引时不编造行号');
	});

	it('符号超过上限时截断并注明余量', () => {
		const symbols = Array.from({ length: 8 }, (_, index) =>
			symbol({ name: `fn${index}`, file: 'monster.h', startLine: 10 + index }));
		const hint = buildRecoveryLocalHint({ symbols });
		assert.ok(hint.includes('fn5'), '前 6 个符号列出');
		assert.ok(!hint.includes('`fn6`'), '第 7 个起截断');
		assert.ok(hint.includes('其余 2 个符号'));
	});
});
