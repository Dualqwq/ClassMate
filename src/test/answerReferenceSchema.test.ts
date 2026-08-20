import * as assert from 'assert';
import { describe, it } from 'mocha';
import { salvageTruncatedReferences } from '../chat/answerReferenceSchema';

describe('salvageTruncatedReferences', () => {
	it('抢救出截断前已完整的条目(全文件枚举型响应被 maxTokens 截断)', () => {
		// 诊断取证 2026-08-20 的形态:条目在字符串中间被硬截断。
		const truncated =
			'{"r":[{"f":"card.h","s":"Card","l":26,"t":"type"},' +
			'{"f":"creature.h","s":"takeDamage","l":29,"t":"func"},' +
			'{"f":"player.h","s":"startTu';
		const result = salvageTruncatedReferences(truncated);
		assert.ok(result);
		assert.strictEqual(result.r.length, 2);
		assert.deepStrictEqual(result.r[0], { f: 'card.h', s: 'Card', l: 26, t: 'type' });
		assert.deepStrictEqual(result.r[1], {
			f: 'creature.h',
			s: 'takeDamage',
			l: 29,
			t: 'func',
		});
	});

	it('没有任何完整条目时返回 undefined', () => {
		assert.strictEqual(salvageTruncatedReferences('{"r":[{"f":"card.h","s":"Ca'), undefined);
		assert.strictEqual(salvageTruncatedReferences('{"r":[]'), undefined);
	});

	it('条目字符串内的转义引号和未配平花括号不干扰边界判定', () => {
		const truncated =
			'{"r":[{"f":"a.h","s":"x\\"{y"},{"f":"b.h","s":"z';
		const result = salvageTruncatedReferences(truncated);
		assert.ok(result);
		assert.strictEqual(result.r.length, 1);
		assert.strictEqual(result.r[0].s, 'x"{y');
	});

	it('逐条按 wire schema 校验,非法条目丢弃', () => {
		const truncated = '{"r":[{"f":"","s":"x"},{"f":"a.h","s":"y"},{"f":"b.h","s":"z';
		const result = salvageTruncatedReferences(truncated);
		assert.ok(result);
		assert.strictEqual(result.r.length, 1);
		assert.strictEqual(result.r[0].f, 'a.h');
	});

	it('完整条目超过 20 条时只保留前 20 条(与 wire schema 上限一致)', () => {
		const items = Array.from(
			{ length: 24 },
			(_, index) => `{"f":"f${index}.h","s":"sym${index}"}`
		);
		const truncated = `{"r":[${items.join(',')}`;
		const result = salvageTruncatedReferences(truncated);
		assert.ok(result);
		assert.strictEqual(result.r.length, 20);
		assert.strictEqual(result.r[0].f, 'f0.h');
		assert.strictEqual(result.r[19].f, 'f19.h');
	});

	it('完整 JSON 同样能取出全部条目', () => {
		const complete = '{"r":[{"f":"a.h","s":"x"},{"f":"b.h","s":"y"}]}';
		const result = salvageTruncatedReferences(complete);
		assert.ok(result);
		assert.strictEqual(result.r.length, 2);
	});
});
