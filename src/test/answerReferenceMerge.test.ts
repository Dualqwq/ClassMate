import * as assert from 'assert';
import { describe, it } from 'mocha';
import {
	mergeContractAndExtractedReferences,
} from '../chat/answerReferenceMerge';
import type { ChatReference } from '../chat/types';

function ref(partial: Partial<ChatReference> & { uri: string; label: string }): ChatReference {
	return { startLine: undefined, symbol: undefined, ...partial };
}

const CONTRACT: ChatReference[] = [
	// 模型标记生成的契约引用:takeTurn @ monster.h:26
	ref({ uri: 'file:///ws/monster.h', label: 'takeTurn', symbol: 'takeTurn', startLine: 26, kind: 'func' }),
	// Creature 类型引用(无行号,符号级)
	ref({ uri: 'file:///ws/creature.h', label: 'Creature', symbol: 'Creature', kind: 'type' }),
];

describe('mergeContractAndExtractedReferences (一律提取、只补缺、冲突以 Answer 为准)', () => {
	it('keeps contract references verbatim and appends only non-overlapping extracted ones', () => {
		const extracted: ChatReference[] = [
			// 同符号同行 → 模型已提及,丢弃
			ref({ uri: 'file:///ws/monster.h', label: 'monster.h:26', symbol: 'takeTurn', startLine: 26 }),
			// 同符号不同行(冲突) → 以模型 Answer 为准,丢弃提取版
			ref({ uri: 'file:///ws/monster.h', label: 'monster.h:34', symbol: 'takeTurn', startLine: 34 }),
			// 同 uri 同行不同符号 → 行级重合,视为已提及
			ref({ uri: 'file:///ws/monster.h', label: 'monster.h:26', symbol: 'printStatus', startLine: 26 }),
			// Creature 符号级重合(提取版带行号) → 丢弃
			ref({ uri: 'file:///ws/creature.h', label: 'creature.h:10', symbol: 'Creature', startLine: 10 }),
			// printStatus @34 → 模型未提及,保留补充
			ref({ uri: 'file:///ws/monster.h', label: 'monster.h:34', symbol: 'printStatus', startLine: 34, kind: 'func' }),
			// playCard @ player.h:75 → 新符号,保留
			ref({ uri: 'file:///ws/player.h', label: 'player.h:75', symbol: 'playCard', startLine: 75, kind: 'func' }),
		];
		const merged = mergeContractAndExtractedReferences(CONTRACT, extracted);
		assert.strictEqual(merged.length, 4);
		assert.deepStrictEqual(merged.slice(0, 2), CONTRACT, '契约引用原样在前');
		assert.ok(merged.some((item) => item.symbol === 'printStatus' && item.startLine === 34));
		assert.ok(merged.some((item) => item.symbol === 'playCard' && item.startLine === 75));
		// 防二次引用:同一符号在合并结果里只出现一次
		const symbols = merged.map((item) => item.symbol);
		assert.strictEqual(new Set(symbols).size, symbols.length);
	});

	it('returns contract references untouched when extraction finds nothing new', () => {
		const extracted = CONTRACT.map((item) => ({ ...item }));
		assert.deepStrictEqual(
			mergeContractAndExtractedReferences(CONTRACT, extracted),
			CONTRACT
		);
	});

	it('returns extracted references as-is when the contract list is empty (旧行为兼容)', () => {
		const extracted: ChatReference[] = [
			ref({ uri: 'file:///a.cpp', label: 'a.cpp:3', symbol: 'main', startLine: 3 }),
		];
		assert.deepStrictEqual(
			mergeContractAndExtractedReferences([], extracted),
			extracted
		);
	});

	it('deduplicates extracted references against each other too (严防二次引用)', () => {
		const extracted: ChatReference[] = [
			ref({ uri: 'file:///a.cpp', label: 'a.cpp:3', symbol: 'main', startLine: 3 }),
			ref({ uri: 'file:///a.cpp', label: 'a.cpp:4', symbol: 'main', startLine: 4 }),
			ref({ uri: 'file:///b.cpp', label: 'b.cpp:9', symbol: 'run', startLine: 9 }),
		];
		const merged = mergeContractAndExtractedReferences([], extracted);
		assert.strictEqual(merged.length, 2);
		assert.ok(merged.every((item) => item.symbol !== 'main' || item.startLine === 3));
	});
});
