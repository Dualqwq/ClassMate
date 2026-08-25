import * as assert from 'assert';
import { describe, it } from 'mocha';
import {
	COURSEWARE_CONTEXT_TOTAL_BUDGET,
	formatCoursewareContext,
	formatFragmentLocator,
} from '../../courseware/coursewarePromptInjector';
import type { CoursewareRetrievalResult } from '../../courseware/types';

function makeResult(overrides: Partial<CoursewareRetrievalResult>): CoursewareRetrievalResult {
	return {
		chunkId: 'a#0',
		sourceId: 'a',
		fileName: 'lecture.pdf',
		pageStart: 2,
		pageEnd: 3,
		content: 'A class is a blueprint.',
		score: 1,
		...overrides,
	};
}

describe('课件注入层（期 2 D8：定位头 + 预算 + 空命中不注入）', () => {
	it('每片段带定位头：《文件名》 · 页码区间', () => {
		const context = formatCoursewareContext([
			makeResult({ pageStart: 2, pageEnd: 3 }),
		]);
		assert.match(context, /Courseware context/);
		assert.match(context, /--- 《lecture\.pdf》 · p\.2-3 ---/);
		assert.match(context, /A class is a blueprint/);
	});

	it('单页显示 p.N；带标题与 slide 标签时按《文件名》 标题 · slide N 展示', () => {
		assert.strictEqual(
			formatFragmentLocator(makeResult({ title: '链表', unitLabel: 'slide 12', pageStart: 12, pageEnd: 12 })),
			'《lecture.pdf》 · 链表 · slide 12'
		);
		assert.strictEqual(
			formatFragmentLocator(makeResult({ pageStart: 5, pageEnd: 5 })),
			'《lecture.pdf》 · p.5'
		);
	});

	it('空命中返回空串，不再注入占位块', () => {
		assert.strictEqual(formatCoursewareContext([]), '');
	});

	it('总预算 4000 字符：放不下的低分片段整片丢弃（后续更小者仍可回填）', () => {
		const filler = 'x'.repeat(300);
		const results = [
			makeResult({ chunkId: 'big#0', sourceId: 'big', content: `${filler}\n${filler}` }), // ~601 字符
			makeResult({ chunkId: 'mid#0', sourceId: 'mid', content: filler }),
			// 低分且放不进剩余预算（但自身 < 总预算）→ 整片丢弃，不截断
			makeResult({ chunkId: 'low-big#0', sourceId: 'low-big', content: 'y'.repeat(3500), score: 0.5 }),
			makeResult({ chunkId: 'tiny-low#0', sourceId: 'tiny-low', content: 'z'.repeat(50), score: 0.4 }),
		];
		const context = formatCoursewareContext(results);
		assert.ok(context.length <= COURSEWARE_CONTEXT_TOTAL_BUDGET, `实际 ${context.length}`);
		assert.ok(context.includes(filler), '高分片段内容保留');
		assert.ok(!context.includes('yyyyy'), '放不下的低分片段整片丢弃');
		assert.ok(context.includes('zzz'), '更小的低分片段回填补位');
	});

	it('单片自身超过总预算时做截断，而非静默超限或整片丢弃', () => {
		const huge = 'a'.repeat(6000);
		const context = formatCoursewareContext([
			makeResult({ chunkId: 'f#0', sourceId: 'f', content: huge }),
			makeResult({ chunkId: 's#0', sourceId: 's', content: 'second', score: 0.9 }),
		]);
		assert.ok(context.length <= COURSEWARE_CONTEXT_TOTAL_BUDGET, `实际 ${context.length}`);
		assert.ok(context.includes(huge.slice(0, 1000)), '超长单片被截断注入');
		assert.ok(!context.includes('second'), '其后低分片段因预算耗尽被丢弃');
	});
});
