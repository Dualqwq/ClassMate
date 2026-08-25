import * as assert from 'assert';
import * as zlib from 'zlib';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { describe, it, after } from 'mocha';
import { parsePptxSlides, parsePptxSlideUnits, extractPptxBuffer } from '../../courseware/pptxExtractor';
import { extractAndChunkCourseware, extractCoursewareDocument } from '../../courseware/coursewareChunker';

// ---- 合成 pptx fixture：手工构造最小 zip（store / deflate 两种压缩方式）----

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) {
			c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		}
		table[n] = c >>> 0;
	}
	return table;
})();

function crc32(buf: Buffer): number {
	let c = 0xffffffff;
	for (let i = 0; i < buf.length; i++) {
		c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
	}
	return (c ^ 0xffffffff) >>> 0;
}

interface ZipInput {
	name: string;
	data: Buffer;
	deflate?: boolean;
}

function buildZip(entries: ZipInput[]): Buffer {
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;
	for (const entry of entries) {
		const nameBuf = Buffer.from(entry.name, 'utf8');
		const method = entry.deflate ? 8 : 0;
		const data = entry.deflate ? zlib.deflateRawSync(entry.data) : entry.data;
		const crc = crc32(entry.data);

		const local = Buffer.alloc(30 + nameBuf.length);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(method, 8);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(data.length, 18);
		local.writeUInt32LE(entry.data.length, 22);
		local.writeUInt16LE(nameBuf.length, 26);
		nameBuf.copy(local, 30);
		locals.push(local, data);

		const central = Buffer.alloc(46 + nameBuf.length);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(method, 10);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(data.length, 20);
		central.writeUInt32LE(entry.data.length, 24);
		central.writeUInt16LE(nameBuf.length, 28);
		central.writeUInt32LE(offset, 42);
		nameBuf.copy(central, 46);
		centrals.push(central);

		offset += local.length + data.length;
	}
	const centralBuffer = Buffer.concat(centrals);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(entries.length, 8);
	eocd.writeUInt16LE(entries.length, 10);
	eocd.writeUInt32LE(centralBuffer.length, 12);
	eocd.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, centralBuffer, eocd]);
}

function slideXml(paragraphs: string[]): string {
	return `<?xml version="1.0" encoding="UTF-8"?><p:sld>${paragraphs
		.map((p) => `<a:p><a:r><a:t>${p}</a:t></a:r></a:p>`)
		.join('')}</p:sld>`;
}

/** 带占位符声明的形状：phAttrs 形如 `type="title"`。 */
function shapeXml(phAttrs: string | null, text: string): string {
	const ph = phAttrs ? `<p:nvPr><p:ph ${phAttrs}/></p:nvPr>` : '<p:nvPr/>';
	return `<p:sp><p:nvSpPr>${ph}</p:nvSpPr>`
		+ `<p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`;
}

describe('courseware pptx extractor', () => {
	const tempFiles: string[] = [];

	after(() => {
		for (const file of tempFiles) {
			fs.rmSync(file, { force: true });
		}
	});

	it('parses slides in numeric order regardless of entry order', () => {
		const buffer = buildZip([
			{ name: 'ppt/slides/slide10.xml', data: Buffer.from(slideXml(['第十页']), 'utf8') },
			{ name: 'ppt/slides/slide2.xml', data: Buffer.from(slideXml(['第二页']), 'utf8') },
			{ name: 'ppt/theme/theme1.xml', data: Buffer.from('<Theme/>', 'utf8') },
		]);
		const slides = parsePptxSlides(buffer);
		assert.deepStrictEqual(slides, ['第二页', '第十页']);
	});

	it('joins runs inside a paragraph and decodes xml entities', () => {
		const xml = '<a:p><a:r><a:t>树的性质：</a:t></a:r><a:r><a:t>n-1 条边</a:t></a:r></a:p>'
			+ '<a:p><a:r><a:t>A &amp; B &lt;C&gt;</a:t></a:r></a:p>';
		const buffer = buildZip([{ name: 'ppt/slides/slide1.xml', data: Buffer.from(xml, 'utf8'), deflate: true }]);
		// 单张 slide 内段落以换行连接，保持分块所需的段落结构。
		assert.deepStrictEqual(parsePptxSlides(buffer), ['树的性质：n-1 条边\nA & B <C>']);
	});

	it('extracts text and page count via extractPptxBuffer', () => {
		const buffer = buildZip([
			{ name: 'ppt/slides/slide1.xml', data: Buffer.from(slideXml(['图论基础']), 'utf8') },
			{ name: 'ppt/slides/slide2.xml', data: Buffer.from(slideXml(['环路的判定']), 'utf8') },
		]);
		const result = extractPptxBuffer(buffer);
		assert.strictEqual(result.pageCount, 2);
		assert.ok(result.text.includes('图论基础'));
		assert.ok(result.text.includes('环路的判定'));
		assert.strictEqual(result.truncated, false);
	});

	it('throws a clear error when the PPTX has no readable text', () => {
		const buffer = buildZip([{ name: 'ppt/media/image1.png', data: Buffer.from([0x89, 0x50]) }]);
		assert.throws(() => extractPptxBuffer(buffer), /No readable text/);
	});

	it('parsePptxSlideUnits 识别 title 占位符，正文不含标题段落', () => {
		const xml = shapeXml('type="title"', '图的遍历') + shapeXml('type="body" idx="1"', 'DFS 与 BFS');
		const buffer = buildZip([{ name: 'ppt/slides/slide7.xml', data: Buffer.from(xml, 'utf8'), deflate: true }]);
		assert.deepStrictEqual(parsePptxSlideUnits(buffer), [
			{ slideNo: 7, title: '图的遍历', paragraphs: ['DFS 与 BFS'] },
		]);
	});

	it('ctrTitle 同样视为标题占位符（封面页）', () => {
		const xml = shapeXml('type="ctrTitle"', '图论与代数结构') + shapeXml(null, '崔勇');
		const buffer = buildZip([{ name: 'ppt/slides/slide1.xml', data: Buffer.from(xml, 'utf8') }]);
		assert.deepStrictEqual(parsePptxSlideUnits(buffer), [
			{ slideNo: 1, title: '图论与代数结构', paragraphs: ['崔勇'] },
		]);
	});

	it('标题缺失时回退首段：首段晋升为标题并移出正文', () => {
		const xml = shapeXml(null, '首段当标题') + shapeXml(null, '第二段正文');
		const buffer = buildZip([{ name: 'ppt/slides/slide2.xml', data: Buffer.from(xml, 'utf8') }]);
		assert.deepStrictEqual(parsePptxSlideUnits(buffer), [
			{ slideNo: 2, title: '首段当标题', paragraphs: ['第二段正文'] },
		]);
	});

	it('shape 外文本（表格等）兜底并入正文，不丢字', () => {
		const xml = '<p:graphicFrame><a:tbl><a:tr><a:tc><a:txBody>'
			+ '<a:p><a:r><a:t>表格单元</a:t></a:r></a:p>'
			+ '</a:txBody></a:tc></a:tr></a:tbl></p:graphicFrame>';
		const buffer = buildZip([{ name: 'ppt/slides/slide3.xml', data: Buffer.from(xml, 'utf8'), deflate: true }]);
		assert.deepStrictEqual(parsePptxSlideUnits(buffer), [
			{ slideNo: 3, title: '表格单元', paragraphs: [] },
		]);
	});

	it('routes .pptx files through the pptx branch in extractAndChunkCourseware', async function () {
		this.timeout(20000);
		const buffer = buildZip([
			{ name: 'ppt/slides/slide1.xml', data: Buffer.from(slideXml(['二叉树的定义']), 'utf8'), deflate: true },
			{ name: 'ppt/slides/slide2.xml', data: Buffer.from(slideXml(['Huffman 构造算法']), 'utf8'), deflate: true },
		]);
		const filePath = path.join(os.tmpdir(), `classmate-pptx-fixture-${Date.now()}.pptx`);
		fs.writeFileSync(filePath, buffer);
		tempFiles.push(filePath);

		const chunks = await extractAndChunkCourseware(
			'fixture-src',
			'fixture.pptx',
			vscode.Uri.file(filePath),
			{}
		);
		assert.ok(chunks.length > 0);
		assert.ok(chunks.some((chunk) => chunk.content.includes('二叉树')));
		assert.ok(chunks.every((chunk) => chunk.fileName === 'fixture.pptx'));
		// 期 1：slide 为硬边界，页号真实且带单元标签。
		assert.ok(chunks.every((chunk) => chunk.pageStart === chunk.pageEnd));
		assert.deepStrictEqual(chunks.map((chunk) => chunk.unitLabel), ['slide 1', 'slide 2']);
		assert.strictEqual(chunks[0].title, '二叉树的定义');
	});

	it('期 2：extractCoursewareDocument 返回真实 slide 总数，尾部纯图 slide 不再低估 pageCount', async function () {
		this.timeout(20000);
		// slide2 无任何文本（纯图页）：不产 chunk，但 page 计数必须仍为 2。
		const buffer = buildZip([
			{ name: 'ppt/slides/slide1.xml', data: Buffer.from(slideXml(['链表的定义']), 'utf8'), deflate: true },
			{ name: 'ppt/slides/slide2.xml', data: Buffer.from('<p:sld><p:spTree/></p:sld>', 'utf8'), deflate: true },
		]);
		const filePath = path.join(os.tmpdir(), `classmate-pptx-pagecount-${Date.now()}.pptx`);
		fs.writeFileSync(filePath, buffer);
		tempFiles.push(filePath);

		const { chunks, pageCount } = await extractCoursewareDocument(
			'pagecount-src',
			'fixture.pptx',
			vscode.Uri.file(filePath),
			{}
		);
		assert.strictEqual(pageCount, 2, 'pageCount 取解析层 slide 总数而非最后一块的页号');
		assert.ok(chunks.every((chunk) => chunk.pageEnd <= 1), '纯图 slide 不产 chunk');
	});
});
