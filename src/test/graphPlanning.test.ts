import * as assert from 'assert';
import { describe, it } from 'mocha';
import {
	buildLearnerState,
	fallbackPlan,
	inferConcepts,
	sanitizePlannerResult,
	validateCorrectedAnswer,
	validateStudentAnswer,
} from '../graph/planning';
import { buildDefaultAnswerPlan } from '../graph/taskRegistry';
import { RUN13_T2, RUN13_T3 } from './fixtures-run13-corrected';

describe('V4 graph planning safeguards', () => {
	it('detects beginner concepts without calling a model', () => {
		assert.deepStrictEqual(
			inferConcepts('我不理解指针作为函数参数是什么意思'),
			['指针', '函数参数']
		);
	});

	it('does not let Planner change a frozen request type', () => {
		const learner = buildLearnerState('请给我一个提示', []);
		const unsafe = buildDefaultAnswerPlan('solution_request', ['指针'], 4);
		const sanitized = sanitizePlannerResult(
			{ answerPlan: unsafe, skillRetrievalQuery: unsafe.skillQuery },
			'problem_hint',
			learner
		);
		assert.strictEqual(sanitized.answerPlan.requestType, 'problem_hint');
		assert.strictEqual(sanitized.skillRetrievalQuery.requestType, 'problem_hint');
		assert.strictEqual(sanitized.answerPlan.allowCompleteCode, false);
		assert.strictEqual(sanitized.answerPlan.depthLevel, 1);
	});

	it('rejects a long complete program in hint mode', () => {
		const plan = buildDefaultAnswerPlan('problem_hint', ['指针']);
		const longCode = `\`\`\`cpp\n${Array.from(
			{ length: 20 },
			(_, index) => `int value${index} = ${index};`
		).join('\n')}\n\`\`\``;
		const result = validateStudentAnswer(longCode, plan);
		assert.strictEqual(result.valid, false);
		assert.ok(result.problems.some((problem) => problem.includes('完整代码')));
	});

	it('rejects an overlong first-level hint', () => {
		const plan = buildDefaultAnswerPlan('problem_hint', ['链表'], 1);
		const result = validateStudentAnswer('线索：'.repeat(400), plan);

		assert.strictEqual(result.valid, false);
		assert.ok(result.problems.some((problem) => problem.includes('第一层提示过长')));
	});
});

describe('validateCorrectedAnswer (7.9 修正版采用校验)', () => {
	const codeEditPlan = buildDefaultAnswerPlan('code_edit', ['函数']);

	it('adopts the run13 multi-file corrected answer that the strict validator rejected', () => {
		// run13 取证:bug1-multi-1 T2 的修正版含 4 个文件的代码块,
		// 被"code_edit 恰好一个替换块"规则否决后退化成通用兜底。
		const corrected = RUN13_T2;
		assert.ok(corrected, '夹具缺失');
		assert.strictEqual(
			validateStudentAnswer(corrected, codeEditPlan).valid,
			false,
			'前置:严格校验确实拒绝(回归锚点)'
		);
		assert.strictEqual(
			validateCorrectedAnswer(corrected, codeEditPlan).valid,
			true,
			'修正版采用校验应放行多文件要点式修正'
		);
	});

	it('adopts a pure-text guidance corrected answer with no code block', () => {
		const corrected = RUN13_T3;
		assert.ok(corrected);
		assert.strictEqual(
			validateCorrectedAnswer(corrected, codeEditPlan).valid,
			true,
			'纯文字指导修正应被采用(0 代码块不再是问题)'
		);
	});

	it('still rejects empty answers and leaked internal tags', () => {
		assert.strictEqual(validateCorrectedAnswer('   ', codeEditPlan).valid, false);
		assert.strictEqual(
			validateCorrectedAnswer('Frozen workspace data 里说…', codeEditPlan).valid,
			false
		);
	});

	it('still enforces the hint-level code budget on corrected answers', () => {
		const plan = { ...codeEditPlan, allowCompleteCode: false };
		const bigCode = `\`\`\`cpp\n${Array.from(
			{ length: 35 },
			(_, index) => `int value${index} = ${index};`
		).join('\n')}\n\`\`\``;
		assert.strictEqual(validateCorrectedAnswer(bigCode, plan).valid, false);
	});
});

describe('unconverted marker leak guard (run14 竖线笔误防泄漏)', () => {
	const plan = buildDefaultAnswerPlan('concept_explanation', ['函数']);

	it('rejects any unconverted marker form, colon or pipe', () => {
		assert.strictEqual(
			validateStudentAnswer('{{ref:sym:monster.h:Monster:takeTurn|takeTurn}} 在这', plan).valid,
			false,
			'冒号形态残标记触发重生成'
		);
		assert.strictEqual(
			validateStudentAnswer('{{ref|sym:monster.h:Monster:takeTurn|takeTurn}} 在这', plan).valid,
			false,
			'竖线笔误形态同样触发重生成(run14 取证形态)'
		);
		assert.strictEqual(
			validateCorrectedAnswer('{{ref|sym:x|y}}', plan).valid,
			false,
			'修正版同样受保护'
		);
	});

	it('does not flag ordinary braces in normal teaching text', () => {
		assert.strictEqual(
			validateStudentAnswer('初始化列表写在 { } 里,别漏了分号;数组是 {1, 2, 3}。', plan).valid,
			true
		);
	});
});

describe('solution_request teaching guard (#30)', () => {
	it('fallbackPlan never allows complete code for solution_request', () => {
		const learner = buildLearnerState('给我完整代码', []);
		assert.strictEqual(learner.wantsCompleteSolution, true);
		const result = fallbackPlan('solution_request', ['链表'], learner);
		assert.strictEqual(result.answerPlan.allowCompleteCode, false);
		assert.ok(result.answerPlan.mustAvoid.includes('不要直接给出完整代码或完整程序'));
	});

	it('sanitizePlannerResult overrides model attempt to allow complete code for solution_request', () => {
		const learner = buildLearnerState('给我完整代码', []);
		const unsafe = buildDefaultAnswerPlan('solution_request', ['链表'], 4);
		assert.strictEqual(unsafe.allowCompleteCode, true);
		const sanitized = sanitizePlannerResult(
			{ answerPlan: unsafe, skillRetrievalQuery: unsafe.skillQuery },
			'solution_request',
			learner
		);
		assert.strictEqual(sanitized.answerPlan.allowCompleteCode, false);
		assert.strictEqual(sanitized.answerPlan.requestType, 'solution_request');
		assert.ok(sanitized.answerPlan.mustAvoid.includes('不要直接给出完整代码或完整程序'));
	});

	it('validateStudentAnswer rejects a long complete program for solution_request', () => {
		const plan = buildDefaultAnswerPlan('solution_request', ['链表'], 1);
		const longCode = `\`\`\`cpp\n${Array.from(
			{ length: 25 },
			(_, index) => `int value${index} = ${index};`
		).join('\n')}\n\`\`\``;
		const result = validateStudentAnswer(longCode, plan);
		assert.strictEqual(result.valid, false);
		assert.ok(result.problems.some((problem) => problem.includes('solution_request')));
	});

	it('still allows a short illustrative snippet for solution_request', () => {
		const plan = buildDefaultAnswerPlan('solution_request', ['链表'], 1);
		const shortSnippet = '先定义一个节点结构:\n\`\`\`cpp\nstruct Node { int data; Node* next; };\n\`\`\`\n然后想想头指针怎么移动。';
		const result = validateStudentAnswer(shortSnippet, plan);
		assert.strictEqual(result.valid, true);
	});
});
