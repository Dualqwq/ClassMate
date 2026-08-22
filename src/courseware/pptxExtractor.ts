import * as zlib from 'zlib';

const MAX_PPTX_BYTES = 20 * 1024 * 1024;
const MAX_EXTRACTED_CHARACTERS = 200_000;

export interface PptxExtractionResult {
	text: string;
	/** 幻灯片页数。 */
	pageCount: number;
	truncated: boolean;
}

/**
 * 结构感知的单张幻灯片单元（设计文档期 1）：
 * slide 序号 + 标题 + 正文段落，作为分块的硬边界输入。
 */
export interface PptxSlideUnit {
	/** 幻灯片序号，从 1 起（按文件名编号排序，与放映顺序一致）。 */
	slideNo: number;
	/**
	 * slide 标题：取 title/ctrTitle 占位符的段落文本；
	 * 缺失或为空时回退首个正文段落；整页无文本时为空串。
	 */
	title: string;
	/** 正文段落（不含已识别为标题的段落）。 */
	paragraphs: string[];
}

const CENTRAL_DIR_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;

/**
 * 从 pptx（zip 容器）中按顺序解析每张幻灯片的纯文本。
 * 只依赖 Node 内置 zlib：读取 central directory 定位条目，
 * 支持 store(0) 与 deflate(8) 两种压缩方式；不校验 CRC 以保持轻量。
 */
export function parsePptxSlides(buffer: Buffer): string[] {
	if (buffer.byteLength > MAX_PPTX_BYTES) {
		throw new Error(`PPTX exceeds the ${MAX_PPTX_BYTES / 1024 / 1024} MB local parsing limit.`);
	}
	const entries = readZipEntries(buffer);
	const slideNumbers: { number: number; xml: string }[] = [];
	for (const entry of entries) {
		const match = entry.name.match(/^ppt\/slides\/slide(\d+)\.xml$/i);
		if (!match) {
			continue;
		}
		slideNumbers.push({ number: Number.parseInt(match[1], 10), xml: entry.data.toString('utf8') });
	}
	slideNumbers.sort((a, b) => a.number - b.number);
	return slideNumbers.map((slide) => extractSlideText(slide.xml));
}

/**
 * 按结构解析每张幻灯片：按 <p:sp> 形状分组，识别 title/ctrTitle 占位符取标题，
 * 其余形状段落为正文；shape 外的 <a:p>（表格等）兜底并入正文尾部，保证不丢字。
 */
export function parsePptxSlideUnits(buffer: Buffer): PptxSlideUnit[] {
	if (buffer.byteLength > MAX_PPTX_BYTES) {
		throw new Error(`PPTX exceeds the ${MAX_PPTX_BYTES / 1024 / 1024} MB local parsing limit.`);
	}
	const entries = readZipEntries(buffer);
	const slideNumbers: { number: number; xml: string }[] = [];
	for (const entry of entries) {
		const match = entry.name.match(/^ppt\/slides\/slide(\d+)\.xml$/i);
		if (!match) {
			continue;
		}
		slideNumbers.push({ number: Number.parseInt(match[1], 10), xml: entry.data.toString('utf8') });
	}
	slideNumbers.sort((a, b) => a.number - b.number);
	return slideNumbers.map((slide) => ({ slideNo: slide.number, ...extractSlideUnits(slide.xml) }));
}

/**
 * 抽取 pptx 全文并返回与 PdfExtractionResult 对齐的结构，供统一分块入口使用。
 */
export function extractPptxBuffer(buffer: Buffer): PptxExtractionResult {
	const slides = parsePptxSlides(buffer);
	const text = slides.join('\n\n').replace(/\r\n/g, '\n').trim();
	if (!text) {
		throw new Error('No readable text found in the PPTX. It may contain only images.');
	}
	const truncated = text.length > MAX_EXTRACTED_CHARACTERS;
	return {
		text: truncated ? text.slice(0, MAX_EXTRACTED_CHARACTERS) : text,
		pageCount: slides.length,
		truncated,
	};
}

interface ZipEntry {
	name: string;
	data: Buffer;
}

function readZipEntries(buffer: Buffer): ZipEntry[] {
	const eocdOffset = findEocdOffset(buffer);
	if (eocdOffset < 0) {
		throw new Error('Invalid PPTX file: zip end-of-central-directory record not found.');
	}
	const entryCount = buffer.readUInt16LE(eocdOffset + 10);
	let offset = buffer.readUInt32LE(eocdOffset + 16);
	const entries: ZipEntry[] = [];
	for (let i = 0; i < entryCount; i++) {
		if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_DIR_SIGNATURE) {
			break;
		}
		const method = buffer.readUInt16LE(offset + 10);
		const compressedSize = buffer.readUInt32LE(offset + 20);
		const nameLength = buffer.readUInt16LE(offset + 28);
		const extraLength = buffer.readUInt16LE(offset + 30);
		const commentLength = buffer.readUInt16LE(offset + 32);
		const localHeaderOffset = buffer.readUInt32LE(offset + 42);
		const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);

		// local header 的文件名/extra 长度可能与 central directory 不同，需按 local 头重新定位数据。
		const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
		const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
		const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
		const raw = buffer.subarray(dataStart, dataStart + compressedSize);
		entries.push({ name, data: inflateEntry(raw, method) });

		offset += 46 + nameLength + extraLength + commentLength;
	}
	return entries;
}

function findEocdOffset(buffer: Buffer): number {
	// EOCD 最短 22 字节，注释最长 65535 字节。
	const minOffset = Math.max(0, buffer.length - 22 - 65535);
	for (let offset = buffer.length - 22; offset >= minOffset; offset--) {
		if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) {
			return offset;
		}
	}
	return -1;
}

function inflateEntry(raw: Buffer, method: number): Buffer {
	if (method === 0) {
		return raw;
	}
	if (method === 8) {
		return zlib.inflateRawSync(raw);
	}
	throw new Error(`Unsupported zip compression method in PPTX: ${method}`);
}

/**
 * 从一张幻灯片的 XML 中提取文本：<a:p> 为段落、<a:t> 为文本 run，
 * 段内 run 直接拼接，段间以换行分隔，保住分块所需的段落结构。
 */
function extractSlideText(xml: string): string {
	return collectParagraphs(xml).join('\n');
}

/** title/ctrTitle 占位符：PowerPoint 版式里 slide 标题所在形状。 */
const TITLE_PLACEHOLDER_PATTERN = /<p:ph\b[^>]*\btype="(?:title|ctrTitle)"/;

/**
 * 按 <p:sp> 形状分组解析一张幻灯片：标题占位符的段落拼成标题（取先出现的非空命中），
 * 其余段落按文档顺序作为正文返回；<p:sp> 之外的段落（表格等）兜底并入正文尾部。
 */
function extractSlideUnits(xml: string): { title: string; paragraphs: string[] } {
	const bodyParagraphs: string[] = [];
	let titleText = '';
	const withoutShapes = xml.replace(/<p:sp(?:\s[^>]*)?>[\s\S]*?<\/p:sp>/g, (shapeXml) => {
		const shapeParagraphs = collectParagraphs(shapeXml);
		if (!titleText && TITLE_PLACEHOLDER_PATTERN.test(shapeXml) && shapeParagraphs.length > 0) {
			titleText = shapeParagraphs.join(' ');
		} else {
			bodyParagraphs.push(...shapeParagraphs);
		}
		return '';
	});
	bodyParagraphs.push(...collectParagraphs(withoutShapes));
	// 无标题占位符时回退：首段晋升为标题并从正文移除，避免标题在 content/keywords 中重复计权。
	if (!titleText && bodyParagraphs.length > 0) {
		return { title: bodyParagraphs[0], paragraphs: bodyParagraphs.slice(1) };
	}
	return { title: titleText, paragraphs: bodyParagraphs };
}

function collectParagraphs(xml: string): string[] {
	const paragraphs: string[] = [];
	for (const paragraphMatch of xml.matchAll(/<a:p(?:\s[^>]*)?>([\s\S]*?)<\/a:p>/g)) {
		const runs = [...paragraphMatch[1].matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)]
			.map((runMatch) => decodeXmlEntities(runMatch[1]).trim())
			.filter(Boolean);
		if (runs.length > 0) {
			paragraphs.push(runs.join(''));
		}
	}
	return paragraphs;
}

function decodeXmlEntities(input: string): string {
	return input
		.replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&amp;/g, '&');
}
