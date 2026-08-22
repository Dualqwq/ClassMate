import * as assert from 'assert';
import { describe, it } from 'mocha';
import {
	buildGroundedLocalHint,
	checkAnswerGrounding,
	type GroundingClaim,
} from '../chat/answerGroundingValidator';
import type { CppSymbol } from '../parser/cppWorkspaceIndex';

/** 生成一个带 body 事实的函数符号。 */
function fn(
	targetId: string,
	file: string,
	name: string,
	body: Partial<NonNullable<CppSymbol['body']>> & { nonEmptyStatementCount: number }
): CppSymbol {
	return {
		targetId,
		file,
		name,
		kind: 'method',
		startLine: 26,
		endLine: 31,
		body: {
			empty: body.nonEmptyStatementCount === 0,
			commentOnly: body.commentOnly ?? false,
			nonEmptyStatementCount: body.nonEmptyStatementCount,
			calledNames: body.calledNames ?? [],
		},
	};
}

const ACTIVE_TAKE_TURN = fn(
	'sym:monster.h:Monster:takeTurn',
	'monster.h',
	'takeTurn',
	{ nonEmptyStatementCount: 3, calledNames: ['takeDamage'] }
);
const COMMENTED_TAKE_TURN = fn(
	'sym:monster.h:Monster:takeTurn',
	'monster.h',
	'takeTurn',
	{ nonEmptyStatementCount: 0, commentOnly: true }
);
const EMPTY_TAKE_TURN = fn(
	'sym:monster.h:Monster:takeTurn',
	'monster.h',
	'takeTurn',
	{ nonEmptyStatementCount: 0 }
);

describe('answerGroundingValidator (7.7 结构事实核对)', () => {
	it('flags "只是注释了/只有注释" claims when the symbol body is active', () => {
		const result = checkAnswerGrounding(
			'明白了，你是把 `takeTurn` 里的代码注释掉了，函数体只剩注释。',
			[ACTIVE_TAKE_TURN]
		);
		assert.strictEqual(result.passed, false);
		assert.ok(result.conflicts.length >= 1);
		const conflict = result.conflicts[0];
		assert.strictEqual(conflict.targetId, 'sym:monster.h:Monster:takeTurn');
		assert.strictEqual(conflict.actualFact, 'active');
	});

	it('accepts "只有注释" claims when the body is indeed comment-only', () => {
		const result = checkAnswerGrounding(
			'`takeTurn` 现在只有注释，还没写实际代码。',
			[COMMENTED_TAKE_TURN]
		);
		assert.strictEqual(result.passed, true);
		assert.strictEqual(result.conflicts.length, 0);
	});

	it('flags "函数体是空的" claims when the body has statements', () => {
		const result = checkAnswerGrounding(
			'`takeTurn` 函数体是空的，什么都没做。',
			[ACTIVE_TAKE_TURN]
		);
		assert.strictEqual(result.passed, false);
		assert.strictEqual(result.conflicts[0].actualFact, 'active');
	});

	it('accepts "是空的" when the body is empty', () => {
		const result = checkAnswerGrounding(
			'`takeTurn` 函数体是空的。',
			[EMPTY_TAKE_TURN]
		);
		assert.strictEqual(result.passed, true);
	});

	it('flags wrong line counts: says 1 line, actually 3 statements', () => {
		const result = checkAnswerGrounding(
			'`takeTurn` 里现在只有一行实际代码。',
			[ACTIVE_TAKE_TURN]
		);
		assert.strictEqual(result.passed, false);
		assert.strictEqual(result.conflicts[0].kind, 'count');
	});

	it('flags "已经写完了" when the body is empty', () => {
		const result = checkAnswerGrounding(
			'`takeTurn` 已经写完了，不需要再改。',
			[EMPTY_TAKE_TURN]
		);
		assert.strictEqual(result.passed, false);
		assert.strictEqual(result.conflicts[0].kind, 'completion');
	});

	it('skips claims whose subject symbol cannot be located (宁缺毋滥)', () => {
		const result = checkAnswerGrounding(
			'那段代码只有注释。还有一个函数是空的。',
			[ACTIVE_TAKE_TURN]
		);
		// 无符号指向 → 不校验、不误伤。
		assert.strictEqual(result.passed, true);
		assert.strictEqual(result.claims.length, 0);
	});

	it('skips ambiguous symbols: same name in two containers', () => {
		const duplicated: CppSymbol[] = [
			{ ...ACTIVE_TAKE_TURN, targetId: 'sym:a.h:A:takeTurn', container: 'A', file: 'a.h' },
			{ ...COMMENTED_TAKE_TURN, targetId: 'sym:b.h:B:takeTurn', container: 'B', file: 'b.h' },
		];
		const result = checkAnswerGrounding(
			'`takeTurn` 只有注释。',
			duplicated
		);
		assert.strictEqual(result.passed, true, '同名多目标不校验');
	});

	it('does not treat student question echo as a claim when the sentence negates it', () => {
		// "不是空的" 这类否定措辞不应触发空体声明冲突
		const result = checkAnswerGrounding(
			'`takeTurn` 并不是空的，里面已经有三行代码了。',
			[ACTIVE_TAKE_TURN]
		);
		assert.strictEqual(result.passed, true);
	});

	it('collects located claims with expected fact for diagnostics', () => {
		const result = checkAnswerGrounding(
			'`takeTurn` 已经写完了。',
			[EMPTY_TAKE_TURN]
		);
		const claim: GroundingClaim | undefined = result.claims[0];
		assert.ok(claim);
		assert.strictEqual(claim.kind, 'completion');
		assert.strictEqual(claim.targetId, 'sym:monster.h:Monster:takeTurn');
		assert.strictEqual(claim.statedFact, 'done');
		assert.strictEqual(claim.actualFact, 'empty');
	});
});

describe('grounding claim phrasing from run7 (真实措辞回归)', () => {
	it('catches "还处于注释状态 / 没有真正取消注释" against active code', () => {
		const result = checkAnswerGrounding(
			'明白了，你是说 `takeTurn` 里的三行代码**还处于注释状态**，并没有真正取消注释。',
			[ACTIVE_TAKE_TURN]
		);
		assert.strictEqual(result.passed, false);
		assert.ok(result.conflicts.some((conflict) => conflict.kind === 'comment_only'));
	});

	it('still accepts those phrasings when the body is comment-only', () => {
		const result = checkAnswerGrounding(
			'`takeTurn` 里的三行代码还处于注释状态，并没有真正取消注释。',
			[COMMENTED_TAKE_TURN]
		);
		assert.strictEqual(result.passed, true);
	});

	it('does not treat imperative "把注释取消注释" guidance as a state claim', () => {
		// 祈使句(指导学生去改)不是对当前状态的断言,不得误伤
		const result = checkAnswerGrounding(
			'你可以先试着把 `takeTurn` 注释里的三行代码取消注释。',
			[COMMENTED_TAKE_TURN]
		);
		assert.strictEqual(result.passed, true);
	});
});

	it('states each symbol fact once even when one sentence triggers multiple claim kinds', () => {
		const conflicts = [
			{ kind: 'comment_only' as const, targetId: 'sym:monster.h:Monster:takeTurn', symbolName: 'takeTurn', statedFact: 'comment_only' as const, actualFact: 'active' as const, sentence: 's1' },
			{ kind: 'empty' as const, targetId: 'sym:monster.h:Monster:takeTurn', symbolName: 'takeTurn', statedFact: 'empty' as const, actualFact: 'active' as const, sentence: 's1' },
		];
		const hint = buildGroundedLocalHint(conflicts, [ACTIVE_TAKE_TURN]);
		const occurrences = hint.split('takeTurn`（monster.h 第 26–31 行）').length - 1;
		assert.strictEqual(occurrences, 1, '同一符号只陈述一次事实');
	});

describe('grounding fixes from 2026-08-20 real session (startTurn 翻车回归)', () => {
	const EMPTY_START_TURN: CppSymbol = {
		targetId: 'sym:player.h:Player:startTurn',
		file: 'player.h',
		name: 'startTurn',
		kind: 'method',
		container: 'Player',
		startLine: 40,
		endLine: 45,
		body: { empty: true, commentOnly: true, nonEmptyStatementCount: 0, calledNames: [] },
	};

	it('binds symbols written with parentheses or parameter lists in inline code', () => {
		// 真实形态:`startTurn()`、`takeTurn(Player &player)` 都要能绑定
		const result = checkAnswerGrounding(
			'1. **`startTurn()`** — ✅ 已实现，能量恢复、格挡清零、输出回合信息都正确。',
			[EMPTY_START_TURN]
		);
		assert.strictEqual(result.claims.length, 1, '带括号形态必须绑定并检出完成性声明');
		assert.strictEqual(result.passed, false);
		assert.strictEqual(result.conflicts[0].symbolName, 'startTurn');
	});

	it('binds qualified call forms like `Player::startTurn()`', () => {
		const result = checkAnswerGrounding(
			'`Player::startTurn()` 已经改好了，不需要再动。',
			[EMPTY_START_TURN]
		);
		assert.strictEqual(result.passed, false);
	});

	it('recognizes "✅ 已实现 / 已实现 / 改好了" as completion claims', () => {
		for (const sentence of [
			'`startTurn` ✅ 已实现，功能正确。',
			'`startTurn` 已实现，不需要再动。',
			'`startTurn` 改好了。',
			'`startTurn` 已经改好了。',
		]) {
			const result = checkAnswerGrounding(sentence, [EMPTY_START_TURN]);
			assert.strictEqual(result.passed, false, `应拦截: ${sentence}`);
		}
		// run10 真实形态:"✅ 已写好"(无"经"无"了")也必须覆盖
		for (const sentence of ['`startTurn()` ✅ 已写好。', '`startTurn` 已写好。', '`startTurn` 已完成。', '`startTurn` 已写完。']) {
			const result = checkAnswerGrounding(sentence, [EMPTY_START_TURN]);
			assert.strictEqual(result.passed, false, `应拦截: ${sentence}`);
		}
		// 对照:实现态符号上这些话是对的,不得误伤
		for (const sentence of ['`startTurn` ✅ 已实现。', '`startTurn` 改好了。']) {
			const result = checkAnswerGrounding(sentence, [{
				...EMPTY_START_TURN,
				body: { empty: false, commentOnly: false, nonEmptyStatementCount: 3, calledNames: [] },
			}]);
			assert.strictEqual(result.passed, true, `不应误伤: ${sentence}`);
		}
	});
});

describe('grounding existence claims from run17 review (存在性声明回归)', () => {
	// run17 真实符号布局:三个 printStatus(creature 注释态 / monster 实现 / player 实现)
	const PRINT_STATUS_SYMBOLS: CppSymbol[] = [
		{
			targetId: 'sym:creature.h:Creature:printStatus',
			file: 'creature.h', name: 'printStatus', kind: 'method', container: 'Creature',
			startLine: 90, endLine: 93,
			body: { empty: true, commentOnly: true, nonEmptyStatementCount: 0, calledNames: [] },
		},
		{
			targetId: 'sym:monster.h:Monster:printStatus',
			file: 'monster.h', name: 'printStatus', kind: 'method', container: 'Monster',
			startLine: 33, endLine: 36,
			body: { empty: false, commentOnly: false, nonEmptyStatementCount: 1, calledNames: [] },
		},
		{
			targetId: 'sym:player.h:Player:printStatus',
			file: 'player.h', name: 'printStatus', kind: 'method', container: 'Player',
			startLine: 103, endLine: 105,
			body: { empty: false, commentOnly: false, nonEmptyStatementCount: 1, calledNames: [] },
		},
	];
	const MONSTER_TAKE_TURN_EMPTY: CppSymbol = {
		targetId: 'sym:monster.h:Monster:takeTurn',
		file: 'monster.h', name: 'takeTurn', kind: 'method', container: 'Monster',
		startLine: 26, endLine: 31,
		body: { empty: true, commentOnly: false, nonEmptyStatementCount: 0, calledNames: [] },
	};

	it('run17 done-38 原文:行号范围消歧后,把"已实现却称还没实现"判为冲突', () => {
		// 原文错误句:player.h printStatus(103-105 行)已有实现,模型称还没实现。
		const result = checkAnswerGrounding(
			'- **第 102-105 行 `printStatus`：还没实现**（函数体是空的）',
			PRINT_STATUS_SYMBOLS
		);
		assert.strictEqual(result.passed, false);
		const existence = result.conflicts.find((conflict) => conflict.kind === 'existence');
		assert.ok(existence, '存在性声明必须命中');
		assert.strictEqual(existence.targetId, 'sym:player.h:Player:printStatus');
		assert.strictEqual(existence.actualFact, 'active');
	});

	it('run17 done-38 对照:creature 注释态行上的同款声明不误伤', () => {
		const result = checkAnswerGrounding(
			'- **第 90-93 行 `printStatus`：还没实现**（函数体是空的）',
			PRINT_STATUS_SYMBOLS
		);
		assert.strictEqual(result.passed, true);
	});

	it('run17 mut-comments-to-empty T2 原文:裸名 + 文件提及消歧,"需要补全"指向已实现符号判冲突', () => {
		// 原文错误句:printStatus 在 monster.h 已实现,模型让学生补全。
		const result = checkAnswerGrounding(
			'在 monster.h 中，你需要补全 takeTurn 和 printStatus 两个函数。',
			[...PRINT_STATUS_SYMBOLS, MONSTER_TAKE_TURN_EMPTY]
		);
		assert.strictEqual(result.passed, false);
		// takeTurn(空体)上的"需要补全"是真话,只有 printStatus 冲突。
		assert.deepStrictEqual(
			result.conflicts.map((conflict) => conflict.targetId),
			['sym:monster.h:Monster:printStatus']
		);
		assert.strictEqual(result.conflicts[0].kind, 'existence');
	});

	it('存在性声明的真阴性:注释态/空体符号上"还没实现"不冲突', () => {
		for (const body of [
			{ empty: true, commentOnly: true, nonEmptyStatementCount: 0, calledNames: [] },
			{ empty: true, commentOnly: false, nonEmptyStatementCount: 0, calledNames: [] },
		]) {
			const result = checkAnswerGrounding(
				'`takeTurn` 还没实现，需要补全。',
				[{ ...MONSTER_TAKE_TURN_EMPTY, body }]
			);
			assert.strictEqual(result.passed, true, '空/注释体上该声明为真');
		}
	});

	it('限定容器消歧:`Creature::printStatus` 绑定到基类符号', () => {
		const result = checkAnswerGrounding(
			'`Creature::printStatus` 还没实现。',
			PRINT_STATUS_SYMBOLS
		);
		assert.strictEqual(result.claims.length, 1);
		assert.strictEqual(result.claims[0].targetId, 'sym:creature.h:Creature:printStatus');
		assert.strictEqual(result.passed, true, '基类注释态为真');
	});

	it('文件提及消歧:"player.h 里的 printStatus 已实现"不误伤', () => {
		const result = checkAnswerGrounding(
			'player.h 里的 `printStatus` 已实现。',
			PRINT_STATUS_SYMBOLS
		);
		assert.strictEqual(result.passed, true);
	});

	it('无消歧线索的同名声明跳过(宁缺毋滥保持)', () => {
		const result = checkAnswerGrounding(
			'`printStatus` 还没实现。',
			PRINT_STATUS_SYMBOLS
		);
		assert.strictEqual(result.claims.length, 0, '三个同名无消歧线索不绑定');
	});

	it('疑问措辞不构成断言:"是否需要补全"不冲突', () => {
		const result = checkAnswerGrounding(
			'你可以检查 `use` 函数是否也需要补全。',
			[{
				targetId: 'sym:card.h:Card:use',
				file: 'card.h', name: 'use', kind: 'method', container: 'Card',
				startLine: 77, endLine: 87,
				body: { empty: false, commentOnly: false, nonEmptyStatementCount: 5, calledNames: [] },
			}]
		);
		assert.strictEqual(result.passed, true);
	});

	it('描述句"要实现两件事"不是存在性断言,不冲突', () => {
		const result = checkAnswerGrounding(
			'`takeTurn` 要实现两件事：输出两行信息，然后调用玩家扣血。',
			[{
				...MONSTER_TAKE_TURN_EMPTY,
				body: { empty: false, commentOnly: false, nonEmptyStatementCount: 3, calledNames: ['takeDamage'] },
			}]
		);
		assert.strictEqual(result.passed, true);
	});

	it('裸名绑定:句中无反引号也能绑到唯一符号', () => {
		const result = checkAnswerGrounding(
			'startTurn 还没实现。',
			[{
				targetId: 'sym:player.h:Player:startTurn',
				file: 'player.h', name: 'startTurn', kind: 'method', container: 'Player',
				startLine: 40, endLine: 45,
				body: { empty: false, commentOnly: false, nonEmptyStatementCount: 3, calledNames: [] },
			}]
		);
		assert.strictEqual(result.passed, false, '已实现却称还没实现必须拦截');
		assert.strictEqual(result.conflicts[0].kind, 'existence');
	});

	it('类/字段符号不参与声明绑定,重写描述不误伤', () => {
		// run17 done-verify T4 正确回答形态:基类空体描述 + 类名提及,不得冲突。
		const result = checkAnswerGrounding(
			'`creature.h` 里的 `printStatus`（第 90-93 行）是空的，但 `Player` 和 `Monster` 都重写了它。',
			[
				...PRINT_STATUS_SYMBOLS,
				{
					targetId: 'sym:player.h:Player', file: 'player.h', name: 'Player',
					kind: 'class', startLine: 11, endLine: 105,
				},
				{
					targetId: 'sym:monster.h:Monster', file: 'monster.h', name: 'Monster',
					kind: 'class', startLine: 8, endLine: 37,
				},
			]
		);
		assert.strictEqual(result.passed, true, '空体声明落在注释态基类上为真,类名不参与绑定');
	});
});

describe('grounding contrast sentence binding (#29 状态就近绑定)', () => {
	const FUNC_A = fn('sym:a.h:A:funcA', 'a.h', 'funcA', { nonEmptyStatementCount: 3 });
	const FUNC_B = fn('sym:b.h:B:funcB', 'b.h', 'funcB', { nonEmptyStatementCount: 0 });

	it('binds "已实现" to A and "未实现" to B across 但', () => {
		const result = checkAnswerGrounding(
			'`funcA` 已实现，但 `funcB` 还没实现。',
			[FUNC_A, FUNC_B]
		);
		assert.strictEqual(result.passed, true, '状态描述与事实一致时不应冲突');
		assert.deepStrictEqual(
			result.claims.map((claim) => ({ name: claim.symbolName, kind: claim.kind })),
			[
				{ name: 'funcA', kind: 'completion' },
				{ name: 'funcB', kind: 'existence' },
			]
		);
	});

	it('flags false binding when both clauses contradict facts', () => {
		const result = checkAnswerGrounding(
			'`funcA` 已实现，但 `funcB` 还没实现。',
			[
				{ ...FUNC_A, body: { empty: true, commentOnly: false, nonEmptyStatementCount: 0, calledNames: [] } },
				{ ...FUNC_B, body: { empty: false, commentOnly: false, nonEmptyStatementCount: 3, calledNames: [] } },
			]
		);
		assert.strictEqual(result.passed, false);
		assert.strictEqual(result.conflicts.length, 2);
		assert.ok(result.conflicts.some((c) => c.symbolName === 'funcA' && c.kind === 'completion'));
		assert.ok(result.conflicts.some((c) => c.symbolName === 'funcB' && c.kind === 'existence'));
	});

	it('binds opposite states across comma when no conjunction but mixed polarity', () => {
		const result = checkAnswerGrounding(
			'`funcA` 已实现，`funcB` 未实现。',
			[FUNC_A, FUNC_B]
		);
		assert.strictEqual(result.passed, true);
		assert.deepStrictEqual(
			result.claims.map((claim) => ({ name: claim.symbolName, kind: claim.kind })),
			[
				{ name: 'funcA', kind: 'completion' },
				{ name: 'funcB', kind: 'existence' },
			]
		);
	});

	it('keeps non-contrast enumeration binding both symbols to the same state', () => {
		const result = checkAnswerGrounding(
			'`funcA` 和 `funcB` 都已实现。',
			[FUNC_A, { ...FUNC_B, body: { empty: false, commentOnly: false, nonEmptyStatementCount: 2, calledNames: [] } }]
		);
		assert.strictEqual(result.passed, true);
		assert.strictEqual(result.claims.length, 2);
		assert.ok(result.claims.every((claim) => claim.kind === 'completion'));
	});

	it('respects file mentions when segmenting contrastive clauses', () => {
		const printStatus = {
			targetId: 'sym:player.h:Player:printStatus',
			file: 'player.h', name: 'printStatus', kind: 'method' as const, container: 'Player',
			startLine: 103, endLine: 105,
			body: { empty: false, commentOnly: false, nonEmptyStatementCount: 1, calledNames: [] },
		};
		const takeTurn = {
			targetId: 'sym:monster.h:Monster:takeTurn',
			file: 'monster.h', name: 'takeTurn', kind: 'method' as const, container: 'Monster',
			startLine: 26, endLine: 31,
			body: { empty: true, commentOnly: false, nonEmptyStatementCount: 0, calledNames: [] },
		};
		const result = checkAnswerGrounding(
			'在 player.h 中，`printStatus` 已实现；但在 monster.h 中，`takeTurn` 还没实现。',
			[printStatus, takeTurn]
		);
		assert.strictEqual(result.passed, true);
		assert.deepStrictEqual(
			result.claims.map((claim) => ({ name: claim.symbolName, kind: claim.kind })),
			[
				{ name: 'printStatus', kind: 'completion' },
				{ name: 'takeTurn', kind: 'existence' },
			]
		);
	});
});
