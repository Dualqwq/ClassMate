import * as vscode from 'vscode';
import { extractPdfPages } from '../workspace/pdfExtractor';
import type { CoursewareChunk } from './types';
import { extractWeightedKeywords, MAX_KEYWORDS_PER_CHUNK } from './tokenizer';

const DEFAULT_CHUNK_SIZE = 1200;
const DEFAULT_CHUNK_OVERLAP = 120;

export interface ChunkTextOptions {
	chunkSize?: number;
	chunkOverlap?: number;
}

/**
 * 结构感知分块的输入单元：一页 / 一张 slide 就是一个硬边界单元，
 * 分块不跨单元合并（设计文档期 1，修复 D4）。
 */
export interface CoursewareUnitInput {
	/** 展示用单元标签，如 "p.12" / "slide 12"。 */
	unitLabel: string;
	/** 单元起始页/slide 号（真实页号，修复 D1）。 */
	pageStart: number;
	pageEnd: number;
	/** 单元标题（slide 标题）；PDF 页暂无可靠标题时缺省。 */
	title?: string;
	paragraphs: string[];
}

/**
 * 从 PDF 逐页提取文本并按页边界分块。
 */
export async function extractAndChunkPdf(
	sourceId: string,
	fileName: string,
	uri: vscode.Uri,
	options?: ChunkTextOptions
): Promise<CoursewareChunk[]> {
	const extraction = await extractPdfPages(uri);
	return chunkPdfPages(extraction.pages, sourceId, fileName, options);
}

/**
 * 把逐页文本按页边界分块：一页一个单元，空页跳过。
 */
export function chunkPdfPages(
	pages: string[],
	sourceId: string,
	fileName: string,
	options?: ChunkTextOptions
): CoursewareChunk[] {
	const units: CoursewareUnitInput[] = [];
	for (let i = 0; i < pages.length; i++) {
		const paragraphs = normalizeParagraphs(pages[i]);
		if (paragraphs.length === 0) {
			continue;
		}
		units.push({ unitLabel: `p.${i + 1}`, pageStart: i + 1, pageEnd: i + 1, paragraphs });
	}
	return chunkUnits(units, sourceId, fileName, options);
}

/**
 * 把结构化 slide 单元按 slide 边界分块；标题单独加权并置入 chunk 头部。
 */
export function chunkSlideUnits(
	slides: { slideNo: number; title: string; paragraphs: string[] }[],
	sourceId: string,
	fileName: string,
	options?: ChunkTextOptions
): CoursewareChunk[] {
	const units: CoursewareUnitInput[] = [];
	for (const slide of slides) {
		const paragraphs = normalizeParagraphs(slide.paragraphs.join('\n'));
		const title = slide.title.trim();
		if (paragraphs.length === 0 && !title) {
			continue;
		}
		units.push({
			unitLabel: `slide ${slide.slideNo}`,
			pageStart: slide.slideNo,
			pageEnd: slide.slideNo,
			title: title || undefined,
			paragraphs,
		});
	}
	return chunkUnits(units, sourceId, fileName, options);
}

/**
 * 以页/slide 为硬边界分块：
 * - 单元内按段落聚合，块尺寸 ≤ chunkSize；
 * - 单元内超长段落才二次切分（带 overlap），每片独立成块——
 *   修复旧实现把切片与前块拼接成 ≈2×chunkSize 块的翻倍 bug（D3）；
 * - chunk 页号取所在单元的真实页/slide 号（D1），不再按字符比例估算（D2 消亡）。
 */
export function chunkUnits(
	units: CoursewareUnitInput[],
	sourceId: string,
	fileName: string,
	options?: ChunkTextOptions
): CoursewareChunk[] {
	const chunkSize = options?.chunkSize ?? DEFAULT_CHUNK_SIZE;
	const chunkOverlap = options?.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP;

	const chunks: CoursewareChunk[] = [];

	function pushChunk(unit: CoursewareUnitInput, bodyText: string): void {
		const trimmed = bodyText.trim();
		if (!trimmed && !unit.title) {
			return;
		}
		// 纯标题单元（如章节封面 slide）也要落一块，保证封面在图中可检索。
		const content = unit.title ? (trimmed ? `${unit.title}\n\n${trimmed}` : unit.title) : trimmed;
		chunks.push({
			chunkId: `${sourceId}#${chunks.length}`,
			sourceId,
			fileName,
			pageStart: unit.pageStart,
			pageEnd: unit.pageEnd,
			content,
			keywords: extractWeightedKeywords(unit.title, trimmed || unit.title || '', MAX_KEYWORDS_PER_CHUNK),
			title: unit.title,
			unitLabel: unit.unitLabel,
		});
	}

	for (const unit of units) {
		const countBeforeUnit = chunks.length;
		let buffer = '';
		const flushBuffer = (): void => {
			if (buffer.trim()) {
				pushChunk(unit, buffer);
				buffer = '';
			}
		};

		for (const paragraph of unit.paragraphs) {
			if (paragraph.length > chunkSize) {
				flushBuffer();
				// 超长段落在单元内二次切分：每片独立成块，不与前块拼接（D3）。
				const step = Math.max(1, chunkSize - chunkOverlap);
				for (let start = 0; start < paragraph.length; start += step) {
					pushChunk(unit, paragraph.slice(start, start + chunkSize));
				}
			} else if (buffer.length + paragraph.length + 1 <= chunkSize) {
				buffer = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
			} else {
				flushBuffer();
				buffer = paragraph;
			}
		}
		flushBuffer();
		if (unit.title && chunks.length === countBeforeUnit) {
			pushChunk(unit, '');
		}
	}

	return chunks;
}

/** 与旧全文分块一致的段落归一：空行分段、压缩内部空白。 */
function normalizeParagraphs(text: string): string[] {
	return text
		.split(/\n\s*\n+/)
		.map((paragraph) => paragraph.replace(/\s+/g, ' ').trim())
		.filter(Boolean);
}
