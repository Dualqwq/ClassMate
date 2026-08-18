import * as assert from 'assert';
import { describe, it } from 'mocha';
import {
	buildBug1ReviewBundle,
	buildBug1WorkspaceEvidence,
	matchHumanJudgments,
	parseBug1EvalCheckpoint,
	type Bug1EvalCheckpoint,
	type Bug1HumanJudgment,
} from '../eval/bug1Review';

function checkpointWithAnswer(answer: string): Bug1EvalCheckpoint {
	return {
		schemaVersion: 2,
		version: 'baseline-154fcbd',
		startedAt: '2026-08-18T00:00:00.000Z',
		updatedAt: '2026-08-18T00:01:00.000Z',
		provider: 'deepseek',
		model: 'deepseek-chat',
		plannedTurns: 1,
		results: [{
			conversationId: 'bug1-single-01',
			turn: 1,
			sourceProblem: 'monster.h takeTurn 待实现',
			workspace: '../test_directory_bug1',
			activeFile: 'monster.h',
			prompt: '现在 monster.h 要如何改',
			expectedIntent: 'code_edit',
			mustUse: [],
			mustAvoid: [],
			mutations: [],
			answer,
			status: 'success',
			deliveryOutcome: 'answered',
			startedAt: '2026-08-18T00:00:00.000Z',
			totalDurationMs: 1000,
			usageByNode: {},
			workspaceEvidence: {
				snapshotId: 'snapshot-1',
				files: [{
					path: 'monster.h',
					kind: 'code',
					content: 'void takeTurn() {}',
					contentHash: 'hash-1',
					reason: 'active file',
				}],
			},
		}],
	};
}

describe('bug1 human review data', () => {
	it('invalidates an old judgment when the evaluated answer changes', () => {
		const firstBundle = buildBug1ReviewBundle(checkpointWithAnswer('first answer'));
		const firstItem = firstBundle.items[0];
		const judgment: Bug1HumanJudgment = {
			schemaVersion: 1,
			reviewId: firstItem.reviewId,
			verdict: 'pass',
			dimensions: {
				workspaceGrounded: true,
				answersQuestion: true,
				teachingHelpful: true,
				hintLevelCompliant: true,
				referencesCorrect: null,
				genericFallback: false,
			},
			failureTags: [],
			reviewer: 'reviewer-1',
			reviewedAt: '2026-08-18T00:02:00.000Z',
			caseHash: firstItem.caseHash,
			runHash: firstItem.runHash,
		};

		const sameBundle = buildBug1ReviewBundle(checkpointWithAnswer('first answer'));
		assert.strictEqual(sameBundle.items[0].caseHash, firstItem.caseHash);
		assert.strictEqual(sameBundle.items[0].runHash, firstItem.runHash);
		assert.strictEqual(matchHumanJudgments(sameBundle, [judgment]).valid.length, 1);

		const changedBundle = buildBug1ReviewBundle(checkpointWithAnswer('changed answer'));
		assert.strictEqual(changedBundle.items[0].caseHash, firstItem.caseHash);
		assert.notStrictEqual(changedBundle.items[0].runHash, firstItem.runHash);
		const matched = matchHumanJudgments(changedBundle, [judgment]);
		assert.strictEqual(matched.valid.length, 0);
		assert.strictEqual(matched.stale.length, 1);
	});

	it('rejects duplicate review ids before a human starts grading', () => {
		const value = checkpointWithAnswer('answer');
		value.results.push({ ...value.results[0] });
		assert.throws(
			() => parseBug1EvalCheckpoint(value),
			/Duplicate review id: bug1-single-01#1/
		);
	});

	it('rejects a run that does not contain the workspace shown to the model', () => {
		const value = checkpointWithAnswer('answer') as unknown as {
			results: Array<Record<string, unknown>>;
		};
		delete value.results[0].workspaceEvidence;
		assert.throws(
			() => parseBug1EvalCheckpoint(value),
			/workspaceEvidence/
		);
	});

	it('keeps the exact loaded file content that was shown to the model', () => {
		const evidence = buildBug1WorkspaceEvidence({
			snapshotId: 'snapshot-exact',
			createdAt: 1,
			minimal: {
				catalog: { files: [], questionFiles: [] },
			},
			loadedItems: [{
				path: 'monster.h',
				kind: 'code',
				content: 'void takeTurn() { /* current */ }',
				contentHash: 'current-hash',
				reason: 'user named file',
			}],
		});
		assert.deepStrictEqual(evidence, {
			snapshotId: 'snapshot-exact',
			files: [{
				path: 'monster.h',
				kind: 'code',
				content: 'void takeTurn() { /* current */ }',
				contentHash: 'current-hash',
				reason: 'user named file',
			}],
		});
	});
});
