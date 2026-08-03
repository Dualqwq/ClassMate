import * as assert from 'assert';
import { describe, it } from 'mocha';
import { CorrectnessCheckPromptBuilder } from '../prompts/correctnessCheckPromptBuilder';
import { ProblemConstraintPromptBuilder } from '../prompts/problemConstraintPromptBuilder';
import { buildDefaultAnswerPlan } from '../graph/taskRegistry';
import type { WorkspaceContextSnapshot } from '../workspace/types';

describe('correctness prompt safeguards', () => {
	it('bounds workspace evidence and marks it as untrusted', () => {
		const longTail = 'SHOULD_NOT_REACH_CONSTRAINT_MODEL';
		const snapshot: WorkspaceContextSnapshot = {
			snapshotId: 'snapshot',
			createdAt: 1,
			minimal: {
				catalog: { files: [], questionFiles: [] },
			},
			loadedItems: [{
				path: 'question.md',
				kind: 'question',
				content: `${'题'.repeat(13_000)}${longTail}`,
				contentHash: 'hash',
				reason: 'test',
			}],
		};
		const messages = new ProblemConstraintPromptBuilder().build({
			userText: '这题有什么限制？',
			answerPlan: buildDefaultAnswerPlan('problem_understanding', []),
			workspaceSnapshot: snapshot,
		});
		const prompt = messages.map((message) => message.content).join('\n');

		assert.match(prompt, /untrusted data/i);
		assert.match(prompt, /question\.md/);
		assert.doesNotMatch(prompt, new RegExp(longTail));
	});

	it('requires arithmetic, example, constraint, and interface checks', () => {
		const messages = new CorrectnessCheckPromptBuilder().build({
			userText: '给一个反例',
			candidateAnswer: '候选反例。',
			answerPlan: buildDefaultAnswerPlan('concept_explanation', ['最短路']),
			constraints: {
				hardConstraints: ['边权可能为负'],
				requiredOperations: [],
				inputLimits: [],
				expectedBehaviors: [],
				uncertainItems: [],
				evidencePaths: [],
			},
			allowCorrection: false,
		});
		const prompt = messages.map((message) => message.content).join('\n');

		assert.match(prompt, /algorithm applicability and complexity/i);
		assert.match(prompt, /recompute every stated weight/i);
		assert.match(prompt, /invented classes, members, signatures/i);
		assert.match(prompt, /候选反例/);
	});
});

