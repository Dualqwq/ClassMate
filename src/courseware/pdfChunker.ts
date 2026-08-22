import * as vscode from 'vscode';
import { extractPdfUri, type PdfExtractionResult } from '../workspace/pdfExtractor';
import type { CoursewareChunk } from './types';

const DEFAULT_CHUNK_SIZE = 1200;
const DEFAULT_CHUNK_OVERLAP = 120;
const MAX_KEYWORDS_PER_CHUNK = 12;

export interface ChunkTextOptions {
	chunkSize?: number;
	chunkOverlap?: number;
}

/**
 * 从 PDF 提取文本并按滑动窗口分块。
 * 规则：
 * - 优先按自然段边界切分；
 * - 单段超过 chunkSize 时按字符硬切；
 * - 相邻 chunk 保留 overlap 字符，保证上下文连贯。
 */
export async function extractAndChunkPdf(
	sourceId: string,
	fileName: string,
	uri: vscode.Uri,
	options?: ChunkTextOptions
): Promise<CoursewareChunk[]> {
	const extraction: PdfExtractionResult = await extractPdfUri(uri);
	return chunkExtractedText(extraction.text, extraction.pageCount, sourceId, fileName, options);
}

/**
 * 把已抽取的纯文本按滑动窗口分块；PDF 与 PPTX 解析器共用。
 */
export function chunkExtractedText(
	text: string,
	pageCount: number,
	sourceId: string,
	fileName: string,
	options?: ChunkTextOptions
): CoursewareChunk[] {
	const chunkSize = options?.chunkSize ?? DEFAULT_CHUNK_SIZE;
	const chunkOverlap = options?.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP;

	const paragraphs = text
		.split(/\n\s*\n+/)
		.map((paragraph) => paragraph.replace(/\s+/g, ' ').trim())
		.filter(Boolean);

	const chunks: CoursewareChunk[] = [];
	let currentBuffer = '';
	let currentPage = 1;

	function flushBuffer(forceTail?: string): void {
		const content = (currentBuffer + (forceTail ? ` ${forceTail}` : '')).trim();
		if (!content) {
			return;
		}
		chunks.push(buildChunk(chunks.length, content, currentPage, pageCount));
	}

	function buildChunk(index: number, content: string, pageStart: number, pageEnd: number): CoursewareChunk {
		return {
			chunkId: `${sourceId}#${index}`,
			sourceId,
			fileName,
			pageStart,
			pageEnd,
			content,
			keywords: extractKeywords(content),
		};
	}

	for (const paragraph of paragraphs) {
		// 粗略按页码推断：假设每页文本量大致均匀分布。
		const progressRatio = text.length > 0
			? (currentBuffer.length + paragraph.length) / text.length
			: 0;
		currentPage = Math.max(1, Math.min(pageCount, Math.floor(progressRatio * pageCount) + 1));

		if (paragraph.length > chunkSize) {
			flushBuffer();
			currentBuffer = '';
			for (let start = 0; start < paragraph.length; start += chunkSize - chunkOverlap) {
				const slice = paragraph.slice(start, start + chunkSize);
				if (start > 0) {
					flushBuffer(slice);
					currentBuffer = slice;
				} else {
					currentBuffer = slice;
				}
			}
		} else if (currentBuffer.length + paragraph.length + 1 <= chunkSize) {
			currentBuffer = currentBuffer ? `${currentBuffer}\n\n${paragraph}` : paragraph;
		} else {
			flushBuffer();
			currentBuffer = paragraph;
		}
	}
	flushBuffer();

	return chunks;
}

function extractKeywords(content: string): string[] {
	// 简单中文/英文混合关键词提取：保留 2–8 字符的词组，去停用词。
	const stopWords = new Set([
		'的', '了', '是', '在', '和', '与', '或', '等', '对', '为', '有', '被', '将', '从', '到', '可以',
		'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'to', 'of', 'and', 'in',
		'on', 'at', 'by', 'for', 'with', 'about', 'as', 'into', 'through', 'this', 'that', 'these', 'those',
	]);
	const counters = new Map<string, number>();
	const add = (word: string): void => {
		const normalized = word.trim().toLowerCase();
		if (normalized.length < 2 || stopWords.has(normalized)) {
			return;
		}
		counters.set(normalized, (counters.get(normalized) ?? 0) + 1);
	};

	// 英文单词
	for (const match of content.matchAll(/[A-Za-z][A-Za-z0-9_]{1,24}/g)) {
		add(match[0]);
	}
	// 中文 2–6 字词组
	const cjk = content.replace(/[^\u4e00-\u9fa5]/g, '');
	for (let i = 0; i < cjk.length - 1; i++) {
		for (let len = 2; len <= 6 && i + len <= cjk.length; len++) {
			add(cjk.slice(i, i + len));
		}
	}

	return [...counters.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, MAX_KEYWORDS_PER_CHUNK)
		.map(([word]) => word);
}
