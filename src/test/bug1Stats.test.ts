import * as assert from 'assert';
import { describe, it } from 'mocha';
import {
	formatBug1StatsMarkdown,
	summarizeBug1Run,
	type Bug1StatsResult,
} from '../eval/bug1Stats';

function result(partial: Partial<Bug1StatsResult>): Bug1StatsResult {
	return {
		conversationId: 'case-a',
		turn: 1,
		status: 'success',
		deliveryOutcome: 'answered',
		totalDurationMs: 1000,
		graphDurationMs: 800,
		usageByNode: {},
		...partial,
	};
}

describe('bug1Stats (7.9 运行统计)', () => {
	it('aggregates token usage across nodes and turns with cache ratio', () => {
		const stats = summarizeBug1Run([
			result({
				usageByNode: {
					'route_and_plan': { inputTokens: 1000, outputTokens: 100, cacheHitTokens: 900 },
					'answer': { inputTokens: 3000, outputTokens: 400, cacheHitTokens: 1000 },
				},
			}),
			result({
				turn: 2,
				usageByNode: {
					'answer': { inputTokens: 2000, outputTokens: 600 },
				},
			}),
		]);
		assert.strictEqual(stats.turns, 2);
		assert.strictEqual(stats.inputTokens, 6000);
		assert.strictEqual(stats.outputTokens, 1100);
		assert.strictEqual(stats.cacheHitTokens, 1900);
		assert.strictEqual(stats.cacheHitRatio, 31.7);
		const answer = stats.perNode.find((node) => node.node === 'answer');
		assert.strictEqual(answer?.inputTokens, 5000);
		assert.strictEqual(answer?.outputTokens, 1000);
	});

	it('computes first-token latency percentiles and skips turns without records', () => {
		const values = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
		const stats = summarizeBug1Run(values.map((value, index) => result({
			turn: index + 1,
			firstVisibleMs: value,
		})));
		assert.strictEqual(stats.firstTokenMs?.count, 10);
		assert.strictEqual(stats.firstTokenMs?.avg, 550);
		assert.strictEqual(stats.firstTokenMs?.p50, 500);
		assert.strictEqual(stats.firstTokenMs?.p95, 1000);
		const withGap = summarizeBug1Run([
			result({ firstVisibleMs: 120 }),
			result({ turn: 2, firstVisibleMs: undefined, firstTokenMs: undefined }),
			result({ turn: 3, firstVisibleMs: 480 }),
		]);
		assert.strictEqual(withGap.firstTokenMs?.count, 2);
		assert.strictEqual(withGap.firstTokenMs?.max, 480);
	});

	it('prefers firstVisibleMs over legacy firstTokenMs on the same turn', () => {
		const stats = summarizeBug1Run([
			result({ firstVisibleMs: 800, firstTokenMs: 200 }),
		]);
		assert.strictEqual(stats.firstTokenMs?.avg, 800);
	});

	it('separates turns without model usage (402-style fallbacks) from real turns', () => {
		const stats = summarizeBug1Run([
			result({ usageByNode: { answer: { inputTokens: 100, outputTokens: 5 } } }),
			result({ turn: 2, deliveryOutcome: 'recovery_fallback', usageByNode: {} }),
		]);
		assert.strictEqual(stats.turns, 2);
		assert.strictEqual(stats.turnsWithModelUsage, 1);
		assert.deepStrictEqual(
			stats.byOutcome,
			[
				{ outcome: 'answered', count: 1 },
				{ outcome: 'recovery_fallback', count: 1 },
			]
		);
	});

	it('groups per-case aggregates and falls back to usage summary field', () => {
		const stats = summarizeBug1Run([
			result({ conversationId: 'case-a', usage: { inputTokens: 100, outputTokens: 10 } }),
			result({ conversationId: 'case-a', turn: 2, usage: { inputTokens: 50, outputTokens: 5 } }),
			result({ conversationId: 'case-b', turn: 1, firstTokenMs: 250 }),
		]);
		const caseA = stats.perCase.find((entry) => entry.conversationId === 'case-a');
		assert.strictEqual(caseA?.turns, 2);
		assert.strictEqual(caseA?.inputTokens, 150);
		const caseB = stats.perCase.find((entry) => entry.conversationId === 'case-b');
		assert.strictEqual(caseB?.avgFirstTokenMs, 250);
	});

	it('renders a markdown report with all sections', () => {
		const markdown = formatBug1StatsMarkdown(summarizeBug1Run([
			result({
				firstTokenMs: 900,
				usageByNode: { answer: { inputTokens: 12_000, outputTokens: 300, cacheHitTokens: 6_000 } },
			}),
		]));
		assert.ok(markdown.includes('运行统计(1 轮'));
		assert.ok(markdown.includes('answered × 1'));
		assert.ok(markdown.includes('输入 12.0k'));
		assert.ok(markdown.includes('缓存命中 50%'));
		assert.ok(markdown.includes('p95 0.9s'));
		assert.ok(markdown.includes('| answer |'));
		assert.ok(markdown.includes('| case-a |'));
	});
});
