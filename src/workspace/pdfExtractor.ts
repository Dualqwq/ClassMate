import * as vscode from 'vscode';
import pdfParse = require('pdf-parse');

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
