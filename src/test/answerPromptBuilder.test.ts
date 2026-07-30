import * as assert from 'assert';
import { describe, it } from 'mocha';
import { AnswerPromptBuilder } from '../prompts/answerPromptBuilder';

describe('Answer prompt source-grounding safeguards', () => {
	it('requires the model to analyze loaded source instead of inventing generic code', () => {
		const messages = new AnswerPromptBuilder().build({
			skillCore: 'skill',
			pedagogy: 'pedagogy',
			answerPlan: {
				requestType: 'runtime_error_help',
				depthLevel: 1,
				responsePattern: ['location', 'reason'],
				mustInclude: [],
				mustAvoid: ['complete code'],
				allowCompleteCode: false,
				skillQuery: {
					requestType: 'runtime_error_help',
					concepts: ['linked list'],
					purposes: ['debug'],
					learnerLevel: 'beginner',
					hintLevel: 1,
					maxSections: 1,
					maxTokens: 500,
				},
			},
			assembledSkillContext: 'linked-list guidance',
			assembledProblemCardContext: 'matched diagnostic card',
			problemCardFacts: {
				card: {
					id: 'ds.lab2.zuma',
					kind: 'solution',
					primaryConclusion: 'Use a locally modifiable sequence.',
					evidence: ['Chain reactions are possible.'],
					pitfalls: [],
					verifiedTests: [],
					rejectedClaims: [],
					answerRequirements: ['Verify the current code.'],
				},
				variant: {
					id: 'ds.lab2.zuma.bug-03-linear-insert',
					kind: 'diagnostic',
					primaryConclusion: 'Middle string insert and erase cause O(mn) time.',
					evidence: ['Each middle update moves later characters.'],
					complexity: { time: 'O(mn)', space: 'O(n)' },
					pitfalls: ['An outer index does not remove string movement.'],
					verifiedTests: [],
					rejectedClaims: ['The rank points to the old character.'],
					answerRequirements: ['Lead with the complexity bottleneck.'],
				},
			},
			problemCardMatch: {
				cardId: 'ds.lab2.zuma',
				variantId: 'ds.lab2.zuma.bug-03-linear-insert',
				confidence: 0.99,
				evidence: ['Exact indexed content hash matched.'],
			},
			workspaceSnapshot: {
				snapshotId: 'snapshot',
				createdAt: 1,
				minimal: {
					catalog: { files: [], questionFiles: [] },
					activeFilePreview: 'UNPLANNED_ACTIVE_PREVIEW',
					questionText: 'UNPLANNED_QUESTION_BODY',
				},
				loadedItems: [{
					path: 'task_list.cpp',
					kind: 'code',
					content: 'while (n != index) { n++; current = current->next; }',
					contentHash: 'hash',
					reason: 'user named this file',
				}],
			},
			userText: 'Why does at(-1) loop forever?',
			conversationHistory: [],
		});

		const prompt = messages.map((message) => message.content).join('\n');
		assert.match(prompt, /analyze that exact source code/);
		assert.match(prompt, /Do not replace it with a generic example/);
		assert.match(prompt, /Exact snapshot diagnostic requirement/);
		assert.match(prompt, /make that variant the primary diagnosis/);
		assert.match(prompt, /Structured verified facts/);
		assert.match(prompt, /Middle string insert and erase cause O\(mn\) time/);
		assert.match(
			prompt,
			/has no verifiedTests entry\. Do not invent a concrete input/
		);
		assert.match(prompt, /while \(n != index\)/);
		assert.match(prompt, /skill/);
		assert.doesNotMatch(prompt, /UNPLANNED_ACTIVE_PREVIEW/);
		assert.doesNotMatch(prompt, /UNPLANNED_QUESTION_BODY/);
	});
});
