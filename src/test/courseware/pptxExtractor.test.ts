import * as assert from 'assert';
import * as zlib from 'zlib';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { describe, it, after } from 'mocha';
import { parsePptxSlides, extractPptxBuffer } from '../../courseware/pptxExtractor';
import { extractAndChunkCourseware } from '../../courseware/coursewareChunker';

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
	});
});
