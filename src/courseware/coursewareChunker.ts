import * as vscode from 'vscode';
import type { CoursewareChunk } from './types';
import { chunkExtractedText, extractAndChunkPdf, type ChunkTextOptions } from './pdfChunker';
import { extractPptxBuffer } from './pptxExtractor';

/**
 * 统一的课件抽取分块入口：按扩展名分发到 PDF / PPTX 解析器，
 * 共享同一套滑动窗口分块逻辑。
 */
export async function extractAndChunkCourseware(
	sourceId: string,
	fileName: string,
	uri: vscode.Uri,
	options?: ChunkTextOptions
): Promise<CoursewareChunk[]> {
	if (fileName.toLowerCase().endsWith('.pptx')) {
		const bytes = await vscode.workspace.fs.readFile(uri);
		const extraction = extractPptxBuffer(Buffer.from(bytes));
		return chunkExtractedText(extraction.text, extraction.pageCount, sourceId, fileName, options);
	}
	return extractAndChunkPdf(sourceId, fileName, uri, options);
}
