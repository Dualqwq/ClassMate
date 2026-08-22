import * as vscode from 'vscode';
import type { CoursewareChunk } from './types';
import { chunkPdfPages, chunkSlideUnits, extractAndChunkPdf, type ChunkTextOptions } from './pdfChunker';
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
	if (fileName.toLowerCase().endsWith('.pptx')) {
		const bytes = await vscode.workspace.fs.readFile(uri);
		const slides = parsePptxSlideUnits(Buffer.from(bytes));
		return chunkSlideUnits(capSlidesByCharacters(slides), sourceId, fileName, options);
	}
	return extractAndChunkPdf(sourceId, fileName, uri, options);
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
