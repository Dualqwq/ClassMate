import * as assert from 'assert';
import { describe, it } from 'mocha';
import { chunkPdfPages, chunkSlideUnits, chunkUnits, type CoursewareUnitInput } from '../../courseware/pdfChunker';

describe('courseware 结构感知分块（期 1）', () => {
	it('页为硬边界：chunk 不跨页合并，空页跳过后页号保持真实（D1/D4）', () => {
		const chunks = chunkPdfPages(
			['第一页 二叉树的定义与性质', '第二页 哈夫曼树的构造', '', '第四页 最短路径算法'],
			'src-pages',
			'a.pdf'
		);
		assert.strictEqual(chunks.length, 3);
		assert.deepStrictEqual(
			chunks.map((chunk) => [chunk.pageStart, chunk.pageEnd]),
			[[1, 1], [2, 2], [4, 4]]
		);
		assert.deepStrictEqual(chunks.map((chunk) => chunk.unitLabel), ['p.1', 'p.2', 'p.4']);
		assert.ok(chunks[0].content.includes('二叉树'));
		assert.ok(!chunks[0].content.includes('哈夫曼'), '第一页的块不得混入第二页内容');
		assert.ok(chunks[2].content.includes('最短路径'));
	});

	it('slide 为硬边界：标题置入 content 头部并参与加权 keywords', () => {
		const chunks = chunkSlideUnits(
			[
				{ slideNo: 1, title: '第八章 群', paragraphs: ['半群的基本概念和性质'] },
				{ slideNo: 2, title: '循环群与生成元', paragraphs: ['定理：循环群的子群仍是循环群'] },
			],
			'src-slides',
			'b.pptx'
		);
		assert.strictEqual(chunks.length, 2);
		assert.deepStrictEqual(chunks.map((chunk) => chunk.unitLabel), ['slide 1', 'slide 2']);
		assert.ok(chunks[0].content.startsWith('第八章 群'));
		assert.ok(chunks[0].keywords.includes('半群'));
		assert.ok(!chunks[1].keywords.includes('群'), '子串碎片应被抑制（群 ⊂ 循环群）');
	});

	it('无标题 slide 的 title 缺省，正文完整保留', () => {
		const chunks = chunkSlideUnits(
			[{ slideNo: 3, title: '', paragraphs: ['只有正文的页面'] }],
			'src-slides',
			'b.pptx'
		);
		assert.strictEqual(chunks.length, 1);
		assert.strictEqual(chunks[0].title, undefined);
		assert.strictEqual(chunks[0].content, '只有正文的页面');
	});

	it('纯标题单元（章节封面 slide）也产出一块，保证可检索', () => {
		const chunks = chunkSlideUnits(
			[{ slideNo: 5, title: '第四部分 最优树', paragraphs: [] }],
			'src-cover',
			'b.pptx'
		);
		assert.strictEqual(chunks.length, 1);
		assert.strictEqual(chunks[0].content, '第四部分 最优树');
		assert.ok(chunks[0].pageStart === 5 && chunks[0].pageEnd === 5);
	});

	it('超长段落二次切分：每块 ≤ chunkSize 且不与前块拼接翻倍（D3）', () => {
		const longParagraph = '甲'.repeat(3000);
		const chunks = chunkUnits(
			[{ unitLabel: 'p.1', pageStart: 1, pageEnd: 1, paragraphs: [longParagraph] }],
			'src-long',
			'c.pdf',
			{ chunkSize: 1200, chunkOverlap: 120 }
		);
		assert.ok(chunks.every((chunk) => chunk.content.length <= 1200), '所有块不得超过 chunkSize');
		const step = 1200 - 120;
		assert.strictEqual(chunks.length, Math.ceil(3000 / step));
		// 旧 bug 会把切片与前 buffer 拼成 ≈2400 的块；这里总量只允许 overlap 级冗余。
		const joinedLength = chunks.reduce((sum, chunk) => sum + chunk.content.length, 0);
		assert.ok(joinedLength >= 3000 && joinedLength <= 3000 + 240 * chunks.length);
	});

	it('同页多块共享同一真实页号，下一页从真实号开始（D1/D2）', () => {
		const chunks = chunkPdfPages(['X'.repeat(2500), 'Y'.repeat(100)], 'src-multi', 'd.pdf');
		assert.strictEqual(chunks.length, 4);
		assert.deepStrictEqual(chunks.slice(0, 3).map((chunk) => chunk.pageStart), [1, 1, 1]);
		assert.strictEqual(chunks[3].pageStart, 2);
		assert.strictEqual(chunks[3].pageEnd, 2);
	});

	it('单元内多段落聚合仍受 chunkSize 约束且不跨单元', () => {
		const units: CoursewareUnitInput[] = [
			{ unitLabel: 'slide 1', pageStart: 1, pageEnd: 1, title: 'T', paragraphs: ['a'.repeat(700), 'b'.repeat(700)] },
			{ unitLabel: 'slide 2', pageStart: 2, pageEnd: 2, paragraphs: ['c'.repeat(100)] },
		];
		const chunks = chunkUnits(units, 'src-agg', 'e.pptx', { chunkSize: 1200 });
		// 第一单元两段放不进同一块 → 两块；第二单元独立一块
		assert.strictEqual(chunks.length, 3);
		assert.ok(chunks.every((chunk) => chunk.content.length <= 1200));
		assert.deepStrictEqual(chunks.map((chunk) => chunk.pageStart), [1, 1, 2]);
	});
});
