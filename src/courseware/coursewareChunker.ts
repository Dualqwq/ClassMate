import * as vscode from 'vscode';
import type { CoursewareChunk } from './types';
import { extractPdfPages } from '../workspace/pdfExtractor';
import { chunkPdfPages, chunkSlideUnits, type ChunkTextOptions } from './pdfChunker';
import { parsePptxSlideUnits } from './pptxExtractor';

// 与 workspace/pdfExtractor 全文抽取一致的字符上限：超限丢弃尾部整单元，
// 防止超大课件拖垮建图与上下文（结构化路径按 slide 粒度截断）。
const MAX_EXTRACTED_CHARACTERS = 200_000;

/**
 * 统一的课件抽取分块入口：按扩展名分发到 PDF / PPTX 解析器，
 * 共享同一套「页/slide 硬边界」分块逻辑。
 */
export async function extractAndChunkCourseware(
	sourceId: string,
	fileName: string,
	uri: vscode.Uri,
	options?: ChunkTextOptions
): Promise<CoursewareChunk[]> {
	return (await extractCoursewareDocument(sourceId, fileName, uri, options)).chunks;
}

export interface ExtractedCoursewareDocument {
	chunks: CoursewareChunk[];
	/** 课件真实总页数/slide 数（含尾部纯图页），供导入元数据展示。 */
	pageCount: number;
}

/**
 * 抽取 + 分块，同时返回抽取层的真实总页数。
 * 修复遗留小项「尾部连续纯图页导致 pageCount 低估」：此前 pageCount 取
 * 最后一个含文本 chunk 的 pageEnd，纯图页（无文本、不产 chunk）被漏计；
 * 现直接采用解析器报告的总页数（PDF=parsed.numpages，PPTX=slide XML 文件数）。
 */
export async function extractCoursewareDocument(
	sourceId: string,
	fileName: string,
	uri: vscode.Uri,
	options?: ChunkTextOptions
): Promise<ExtractedCoursewareDocument> {
	if (fileName.toLowerCase().endsWith('.pptx')) {
		const bytes = await vscode.workspace.fs.readFile(uri);
		const slides = parsePptxSlideUnits(Buffer.from(bytes));
		const chunks = chunkSlideUnits(capSlidesByCharacters(slides), sourceId, fileName, options);
		return { chunks, pageCount: slides.length };
	}
	const extraction = await extractPdfPages(uri);
	const chunks = chunkPdfPages(extraction.pages, sourceId, fileName, options);
	return { chunks, pageCount: extraction.pageCount };
}

/** 按 title+段落总字符数截断：超出上限的尾部 slide 整体丢弃。 */
function capSlidesByCharacters(
	slides: ReturnType<typeof parsePptxSlideUnits>
): ReturnType<typeof parsePptxSlideUnits> {
	let total = 0;
	for (let i = 0; i < slides.length; i++) {
		total += slides[i].title.length + slides[i].paragraphs.join('\n').length;
		if (total > MAX_EXTRACTED_CHARACTERS) {
			return slides.slice(0, i);
		}
	}
	return slides;
}
