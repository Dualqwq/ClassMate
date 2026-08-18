import * as assert from 'assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, it } from 'mocha';
import type { Bug1EvalCheckpoint } from '../eval/bug1Review';
import {
	startBug1ReviewServer,
	type RunningBug1ReviewServer,
} from '../eval/bug1ReviewServer';

function checkpoint(): Bug1EvalCheckpoint {
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
			answer: '请检查 `takeTurn`。',
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

describe('bug1 human review HTTP interface', () => {
	const running: RunningBug1ReviewServer[] = [];

	afterEach(async () => {
		await Promise.all(running.splice(0).map((server) => server.close()));
	});

	it('persists a judgment submitted through the review interface', async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'classmate-bug1-review-'));
		const checkpointPath = path.join(directory, 'checkpoint.json');
		const judgmentsPath = path.join(directory, 'judgments.json');
		await fs.writeFile(checkpointPath, JSON.stringify(checkpoint()), 'utf8');

		const server = await startBug1ReviewServer({
			checkpointPath,
			judgmentsPath,
			port: 0,
		});
		running.push(server);

		const sessionResponse = await fetch(`${server.url}/api/session`);
		assert.strictEqual(sessionResponse.status, 200);
		const session = await sessionResponse.json() as {
			bundle: { items: Array<{ reviewId: string }> };
			validJudgments: unknown[];
		};
		assert.strictEqual(session.bundle.items.length, 1);
		assert.strictEqual(session.validJudgments.length, 0);

		const reviewId = session.bundle.items[0].reviewId;
		const saveResponse = await fetch(
			`${server.url}/api/judgments/${encodeURIComponent(reviewId)}`,
			{
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
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
					reviewer: 'human-reviewer',
				}),
			}
		);
		assert.strictEqual(saveResponse.status, 200);
		const refreshedResponse = await fetch(`${server.url}/api/session`);
		const refreshed = await refreshedResponse.json() as {
			summary: {
				total: number;
				reviewed: number;
				unreviewed: number;
				stale: number;
				verdicts: Record<string, number>;
			};
		};
		assert.deepStrictEqual(refreshed.summary, {
			total: 1,
			reviewed: 1,
			unreviewed: 0,
			stale: 0,
			verdicts: { pass: 1, fail: 0, unjudgeable: 0, skip: 0 },
		});

		const saved = JSON.parse(await fs.readFile(judgmentsPath, 'utf8')) as {
			judgments: Array<{
				reviewId: string;
				reviewer: string;
				caseHash: string;
				runHash: string;
			}>;
		};
		assert.strictEqual(saved.judgments.length, 1);
		assert.strictEqual(saved.judgments[0].reviewId, reviewId);
		assert.strictEqual(saved.judgments[0].reviewer, 'human-reviewer');
		assert.match(saved.judgments[0].caseHash, /^[a-f0-9]{64}$/);
		assert.match(saved.judgments[0].runHash, /^[a-f0-9]{64}$/);
	});
});
