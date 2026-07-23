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

export function formatPdfExtraction(result: PdfExtractionResult): string {
	if (result.looksScanned) {
		return `[PDF has ${result.pageCount} page(s), but almost no embedded text was found. It is likely scanned and requires OCR.]`;
	}
	const truncation = result.truncated
		? '\n\n[PDF text was truncated at 200,000 characters to protect the model context.]'
		: '';
	return `[PDF pages: ${result.pageCount}]\n\n${result.text}${truncation}`;
}
