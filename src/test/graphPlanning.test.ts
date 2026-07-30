import * as assert from 'assert';
import { describe, it } from 'mocha';
import {
	buildLearnerState,
	inferConcepts,
	sanitizePlannerResult,
	validateStudentAnswer,
} from '../graph/planning';
import { buildDefaultAnswerPlan } from '../graph/taskRegistry';

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
