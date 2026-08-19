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
