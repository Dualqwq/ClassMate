import * as vscode from 'vscode';
import type pdfParseType = require('pdf-parse');

// pdf-parse 1.1.1 的包入口 index.js 带有依赖作者用于本地调试的测试代码。
// webpack 打包后，入口中的 `!module.parent` 可能被误判为 true，于是它会尝试读取
// 依赖仓库里并未随扩展发布的示例 PDF。真正的解析实现位于 lib/pdf-parse.js，
// 因此这里直接加载该实现，绕过有副作用的入口；类型仍由 @types/pdf-parse 提供。
const pdfParse: typeof pdfParseType = require('pdf-parse/lib/pdf-parse.js');

const MAX_PDF_BYTES = 20 * 1024 * 1024;
const MAX_EXTRACTED_CHARACTERS = 200_000;

export interface PdfExtractionResult {
	text: string;
	pageCount: number;
	truncated: boolean;
	looksScanned: boolean;
}

export async function extractPdfBuffer(buffer: Buffer): Promise<PdfExtractionResult> {
	if (buffer.byteLength > MAX_PDF_BYTES) {
		throw new Error(`PDF exceeds the ${MAX_PDF_BYTES / 1024 / 1024} MB local parsing limit.`);
	}
	const parsed = await pdfParse(buffer);
	const normalized = parsed.text.replace(/\r\n/g, '\n').trim();
	const looksScanned = normalized.replace(/\s/g, '').length < Math.max(20, parsed.numpages * 5);
	const truncated = normalized.length > MAX_EXTRACTED_CHARACTERS;
	return {
		text: truncated ? normalized.slice(0, MAX_EXTRACTED_CHARACTERS) : normalized,
		pageCount: parsed.numpages,
		truncated,
		looksScanned,
	};
}

export async function extractPdfUri(uri: vscode.Uri): Promise<PdfExtractionResult> {
	return extractPdfBuffer(Buffer.from(await vscode.workspace.fs.readFile(uri)));
}

/** 逐页抽取结果：pages[i] 对应第 i+1 页的真实文本。 */
export interface PdfPageExtractionResult {
	pages: string[];
	pageCount: number;
	truncated: boolean;
	looksScanned: boolean;
}

/**
 * 逐页抽取 PDF 文本（结构感知分块的真实页边界来源，修复 D1/D2）。
 * 复用 pdf-parse 的 pagerender 回调逐页收集；单页解析失败按空页占位，
 * 保持 pages 下标与页号严格对齐。looksScanned/truncated 与全文抽取同语义。
 */
export async function extractPdfPages(uri: vscode.Uri): Promise<PdfPageExtractionResult> {
	return extractPdfPagesBuffer(Buffer.from(await vscode.workspace.fs.readFile(uri)));
}

export async function extractPdfPagesBuffer(buffer: Buffer): Promise<PdfPageExtractionResult> {
	if (buffer.byteLength > MAX_PDF_BYTES) {
		throw new Error(`PDF exceeds the ${MAX_PDF_BYTES / 1024 / 1024} MB local parsing limit.`);
	}
	const pages: string[] = [];
	const parsed = await pdfParse(buffer, {
		// 与 pdf-parse 默认 render_page 相同的行合并逻辑（按 y 坐标换行）。
		pagerender: (pageData): Promise<string> =>
			pageData
				.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false })
				.then((textContent: { items: Array<{ str: string; transform: number[] }> }) => {
					let lastY: number | undefined;
					let text = '';
					for (const item of textContent.items) {
						if (lastY === item.transform[5] || lastY === undefined) {
							text += item.str;
						} else {
							text += '\n' + item.str;
						}
						lastY = item.transform[5];
					}
					pages.push(text.replace(/\r\n/g, '\n'));
					return text;
				})
				.catch(() => {
					pages.push('');
					return '';
				}),
	});

	// 全局字符上限：截断发生在页边界（末页可部分保留），保证不产生跨页半块。
	const fullText = pages.join('\n\n');
	const looksScanned = fullText.replace(/\s/g, '').length < Math.max(20, parsed.numpages * 5);
	let truncated = false;
	let total = 0;
	for (let i = 0; i < pages.length; i++) {
		if (total + pages[i].length > MAX_EXTRACTED_CHARACTERS) {
			const remaining = MAX_EXTRACTED_CHARACTERS - total;
			if (remaining > 0) {
				pages[i] = pages[i].slice(0, remaining);
				total += remaining;
				i++;
			}
			pages.length = i;
			truncated = true;
			break;
		}
		total += pages[i].length + 2;
	}

	return { pages, pageCount: parsed.numpages, truncated, looksScanned };
}

export function formatPdfExtraction(result: PdfExtractionResult): string {
	if (result.looksScanned) {
		return `[PDF has ${result.pageCount} page(s), but almost no embedded text was found. It is likely scanned and requires OCR.]`;
	}
	const truncation = result.truncated
		? '\n\n[PDF text was truncated at 200,000 characters to protect the model context.]'
		: '';
	return `[PDF pages: ${result.pageCount}]\n\n${result.text}${truncation}`;
}
