import * as assert from 'assert';
import { describe, it } from 'mocha';
import { addTokenUsage } from '../llm/tokenUsage';

describe('LangGraph token usage aggregation', () => {
	it('adds RouteAndPlan and Answer usage instead of keeping only the last call', () => {
		let total = addTokenUsage(undefined, {
			inputTokens: 100,
			outputTokens: 20,
			totalTokens: 120,
			cacheHitTokens: 10,
		});
		total = addTokenUsage(total, {
			inputTokens: 200,
			outputTokens: 30,
			totalTokens: 230,
			cacheMissTokens: 50,
		});

		assert.deepStrictEqual(total, {
			inputTokens: 300,
			outputTokens: 50,
			totalTokens: 350,
			cacheHitTokens: 10,
			cacheMissTokens: 50,
		});
	});

	it('calculates a missing provider total from input and output', () => {
		assert.strictEqual(addTokenUsage(undefined, {
			inputTokens: 7,
			outputTokens: 3,
		}).totalTokens, 10);
	});

	it('keeps cache fields undefined when the provider does not report them', () => {
		const total = addTokenUsage(
			{ inputTokens: 1, outputTokens: 1 },
			{ inputTokens: 2, outputTokens: 2 }
		);
		assert.strictEqual(total.cacheHitTokens, undefined);
		assert.strictEqual(total.cacheMissTokens, undefined);
	});

	it('keeps a reported cache value even when another call omits it', () => {
		const total = addTokenUsage(
			{ inputTokens: 1, outputTokens: 1, cacheMissTokens: 40 },
			{ inputTokens: 2, outputTokens: 2 }
		);
		assert.strictEqual(total.cacheMissTokens, 40);
		assert.strictEqual(total.cacheHitTokens, undefined);
	});
});
