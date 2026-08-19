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
		assert.match(messages[0].content, /name the exact file you need to see/);
		assert.match(messages[0].content, /never invent its contents/);
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

	it('orders messages stable-first so the DeepSeek prefix cache stays long', () => {
		const messages = new AnswerPromptBuilder().build({
			skillCore: 'skill',
			pedagogy: 'pedagogy',
			answerPlan: {
				requestType: 'concept_explanation',
				depthLevel: 2,
				responsePattern: ['definition', 'example'],
				mustInclude: [],
				mustAvoid: [],
				allowCompleteCode: false,
				skillQuery: {
					requestType: 'concept_explanation',
					concepts: ['pointer'],
					purposes: ['debug'],
					learnerLevel: 'beginner',
					hintLevel: 2,
					maxSections: 1,
					maxTokens: 500,
				},
			},
			assembledSkillContext: 'pointer guidance',
			workspaceSnapshot: {
				snapshotId: 'snap-1',
				createdAt: 1,
				minimal: {
					catalog: { files: [], questionFiles: [] },
					activeFilePreview: 'UNPLANNED_ACTIVE_PREVIEW',
					questionText: 'UNPLANNED_QUESTION_BODY',
				},
				loadedItems: [{
					path: 'main.cpp',
					kind: 'code',
					content: 'int main() { return 0; }',
					contentHash: 'hash',
					reason: 'active',
				}],
			},
			userText: 'What is a pointer?',
			conversationHistory: [],
		});

		assert.match(messages[0].content, /=== ClassMate Answer Mode ===/);
		assert.match(messages[1].content, /=== Frozen workspace data ===/);
		assert.match(messages[2].content, /=== Selected Skill Context ===/);
		assert.match(messages[3].content, /=== Answer plan ===/);
		assert.strictEqual(messages[messages.length - 1].content, 'What is a pointer?');
		assert.ok(messages.length >= 5, 'expected a stable prefix, snapshot, plan and user message');
		const snapshot = messages[1].content;
		assert.match(snapshot, /=== Loaded files \(1-based line numbers\) ===/);
		assert.match(snapshot, /=== Files present in the workspace but not loaded ===/);
		assert.match(snapshot, /\n   1 \| int main\(\) \{ return 0; \}/);
	});

	it('puts volatile snapshot fields after the stable file-content part', () => {
		const messages = new AnswerPromptBuilder().build({
			skillCore: 'skill',
			pedagogy: 'pedagogy',
			answerPlan: {
				requestType: 'concept_explanation',
				depthLevel: 2,
				responsePattern: ['definition', 'example'],
				mustInclude: [],
				mustAvoid: [],
				allowCompleteCode: false,
				skillQuery: {
					requestType: 'concept_explanation',
					concepts: ['pointer'],
					purposes: ['debug'],
					learnerLevel: 'beginner',
					hintLevel: 2,
					maxSections: 1,
					maxTokens: 500,
				},
			},
			assembledSkillContext: 'pointer guidance',
			workspaceSnapshot: {
				snapshotId: 'snap-1',
				createdAt: 1,
				minimal: {
					catalog: { files: [], questionFiles: [] },
					activeFilePreview: 'UNPLANNED_ACTIVE_PREVIEW',
					questionText: 'UNPLANNED_QUESTION_BODY',
				},
				loadedItems: [{
					path: 'main.cpp',
					kind: 'code',
					content: 'int main() { return 0; }',
					contentHash: 'hash',
					reason: 'active',
				}],
			},
			userText: 'What is a pointer?',
			conversationHistory: [],
		});

		const snapshot = messages[1].content;
		const loadedIndex = snapshot.indexOf('=== Loaded files (1-based line numbers) ===');
		const snapshotIdIndex = snapshot.indexOf('"snapshotId"');
		assert.ok(loadedIndex >= 0 && loadedIndex < snapshotIdIndex, 'loaded files must precede snapshotId');
	});

	it('sorts snapshot loadedItems by path and keeps reason after contentHash', () => {
		const messages = new AnswerPromptBuilder().build({
			skillCore: 'skill',
			pedagogy: 'pedagogy',
			answerPlan: {
				requestType: 'concept_explanation',
				depthLevel: 2,
				responsePattern: ['definition', 'example'],
				mustInclude: [],
				mustAvoid: [],
				allowCompleteCode: false,
				skillQuery: {
					requestType: 'concept_explanation',
					concepts: ['pointer'],
					purposes: ['debug'],
					learnerLevel: 'beginner',
					hintLevel: 2,
					maxSections: 1,
					maxTokens: 500,
				},
			},
			assembledSkillContext: 'pointer guidance',
			workspaceSnapshot: {
				snapshotId: 'snap-1',
				createdAt: 1,
				minimal: {
					catalog: { files: [], questionFiles: [] },
					activeFilePreview: 'UNPLANNED_ACTIVE_PREVIEW',
					questionText: 'UNPLANNED_QUESTION_BODY',
				},
				loadedItems: [
					{
						path: 'z_later.cpp',
						kind: 'code',
						content: 'int z() { return 0; }',
						contentHash: 'z-hash',
						reason: 'route selected this file',
					},
					{
						path: 'a_early.cpp',
						kind: 'code',
						content: 'int a() { return 1; }',
						contentHash: 'a-hash',
						reason: 'user named this file',
					},
				],
			},
			userText: 'What is a pointer?',
			conversationHistory: [],
		});

		const snapshot = messages[1].content;
		const aIndex = snapshot.indexOf('a_early.cpp');
		const zIndex = snapshot.indexOf('z_later.cpp');
		assert.ok(aIndex >= 0 && aIndex < zIndex, 'loadedItems must be sorted by path');
		const itemStart = snapshot.indexOf('"path":"a_early.cpp"');
		const hashIndex = snapshot.indexOf('"contentHash"', itemStart);
		const reasonIndex = snapshot.indexOf('"reason"', itemStart);
		assert.ok(hashIndex >= 0 && hashIndex < reasonIndex, 'reason must come after contentHash');
		assert.match(snapshot, /\n   1 \| int a\(\) \{ return 1; \}/);
	});
});

describe('Answer prompt reference-target contract block', () => {
	function buildWithTargets() {
		return new AnswerPromptBuilder().build({
			skillCore: 'skill',
			pedagogy: 'pedagogy',
			answerPlan: {
				requestType: 'concept_explanation',
				depthLevel: 2,
				responsePattern: ['definition'],
				mustInclude: [],
				mustAvoid: [],
				allowCompleteCode: false,
				skillQuery: {
					requestType: 'concept_explanation',
					concepts: ['class'],
					purposes: ['definition'],
					learnerLevel: 'beginner',
					hintLevel: 2,
					maxSections: 1,
					maxTokens: 500,
				},
			},
			assembledSkillContext: 'class guidance',
			workspaceSnapshot: {
				snapshotId: 'snap-1',
				createdAt: 1,
				minimal: {
					catalog: { files: [], questionFiles: [] },
				},
				loadedItems: [{
					path: 'monster.h',
					kind: 'code',
					content: 'class Monster { void takeTurn() {} };',
					contentHash: 'hash',
					reason: 'active',
				}],
			},
			referenceTargets: [{
				targetId: 'sym:monster.h:Monster:takeTurn',
				file: 'monster.h',
				name: 'takeTurn',
				kind: 'method',
				startLine: 26,
			}],
			userText: 'takeTurn 是干什么的?',
			conversationHistory: [],
		});
	}

	it('requires marking EVERY occurrence of a symbol, not just the first mention', () => {
		const prompt = buildWithTargets().map((message) => message.content).join('\n');
		assert.match(prompt, /EVERY occurrence/);
		assert.doesNotMatch(prompt, /first mention/);
	});

	it('shows an example where the same symbol is marked twice', () => {
		const prompt = buildWithTargets().map((message) => message.content).join('\n');
		const markerRegex = /\{\{ref:sym:monster\.h:Monster:takeTurn\|takeTurn\}\}/g;
		const count = (prompt.match(markerRegex) ?? []).length;
		assert.ok(
			count >= 2,
			`示例必须展示同一符号被标记两次,实际出现 ${count} 次`
		);
	});
});
