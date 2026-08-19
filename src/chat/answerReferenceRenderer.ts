import type { ChatReference } from './types';
import { tokenizeMarkdown } from './linkifyAnswer';

/**
 * 引用契约的展示层(v2 增补批次):证词层(answerReferences)只由模型标记生成;
 * 本模块在渲染时保守补链,链接带 ?i 后缀,与模型标记链接(classmate-ref://N)
 * 区分计数。用户边界(2026-08-19):
 * - 该补:工作区 C/C++ 文件名的**任意提及**(含无反引号纯文本,如 create.h);
 *   行内代码中"单个标识符/限定名"且候选目录唯一匹配(函数、无歧义变量、类型);
 * - 不该补:含多个对象的代码(带参调用 `sort(a, n)`、`players[i].playCard(c)`)、
 *   同名多目标、std:: 前缀。
 * 补链结果不回写 answerReferences;文件名补链目标(仅文件,无行号)由
 * 展示层合成目录追加,索引从 N 起不与模型标记冲突。
 */
export interface InferenceOptions {
	/** 本轮工作区实际加载/存在的代码文件路径(相对路径),文件名补链目录。 */
	codeFiles?: string[];
}

const CODE_FILE_NAME = /[A-Za-z0-9_\-./\\]+\.(?:cpp|cc|cxx|c|h|hpp|hh|hxx)\b/g;

function normalizeSlash(text: string): string {
	return text.replace(/\\/g, '/');
}

function fileNameOfUri(uri: string): string {
	return normalizeSlash(decodeURIComponent(uri)).split('/').pop() ?? '';
}

export function inferenceLinkifyAnswer(
	content: string,
	references: ChatReference[],
	options?: InferenceOptions
): string {
	// 展示层合成目录:模型标记引用在前,文件名补链目标追加(去重)。
	const merged: ChatReference[] = [...references];
	const referencedFiles = new Set(references.map((reference) => fileNameOfUri(reference.uri)));
	for (const file of options?.codeFiles ?? []) {
		const base = file.split(/[\\/]/).pop() ?? file;
		if (!base || referencedFiles.has(base)) {
			continue; // 该文件已有精确引用,不再给无行号的文件级链接
		}
		referencedFiles.add(base);
		merged.push({ label: base, uri: `<classmate-workspace-file>/${file}` });
	}
	if (merged.length === 0) {
		return content;
	}
	const fileIndexByName = new Map<string, number>();
	merged.forEach((reference, index) => {
		const base = fileNameOfUri(reference.uri);
		if (base && !fileIndexByName.has(base)) {
			fileIndexByName.set(base, index);
		}
	});
	const symbolCounts = new Map<string, number>();
	for (const reference of references) {
		if (!reference.symbol) {
			continue;
		}
		symbolCounts.set(reference.symbol, (symbolCounts.get(reference.symbol) ?? 0) + 1);
	}
	const uniqueSymbols = new Set<string>();
	for (const [symbol, count] of symbolCounts) {
		if (count === 1) {
			uniqueSymbols.add(symbol);
		}
	}
	return tokenizeMarkdown(content)
		.map((segment) => {
			if (segment.kind === 'inline-code') {
				return linkifyInlineCode(segment.text, references, uniqueSymbols, fileIndexByName);
			}
			if (segment.kind === 'plain') {
				// 纯文本唯一例外:工作区代码文件名的任意提及(用户边界)。
				return linkifyPlainFileNames(segment.text, fileIndexByName);
			}
			return segment.text;
		})
		.join('');
}

/** 纯文本段:只匹配工作区代码文件名(含路径形态),普通标识符永不匹配。 */
function linkifyPlainFileNames(text: string, fileIndexByName: Map<string, number>): string {
	if (fileIndexByName.size === 0) {
		return text;
	}
	let out = '';
	let cursor = 0;
	for (const match of text.matchAll(CODE_FILE_NAME)) {
		const candidate = match[0].replace(/[\\/]+$/, '');
		const base = candidate.split(/[\\/]/).pop() ?? candidate;
		const index = fileIndexByName.has(candidate)
			? fileIndexByName.get(candidate)
			: fileIndexByName.has(base)
				? fileIndexByName.get(base)
				: undefined;
		if (index === undefined || match.index === undefined) {
			continue;
		}
		out += text.slice(cursor, match.index);
		out += `[${candidate}](classmate-ref://${index}?i)`;
		cursor = match.index + candidate.length;
	}
	out += text.slice(cursor);
	return out;
}

/** 行内代码段:内容恰好是单个可链符号或代码文件名时补 inferred 链接;否则保持代码样式。 */
function linkifyInlineCode(
	segment: string,
	references: ChatReference[],
	uniqueSymbols: Set<string>,
	fileIndexByName: Map<string, number>
): string {
	const inner = segment.slice(1, -1).trim();
	const fileIndex = fileIndexByName.get(inner);
	if (fileIndex !== undefined) {
		return `[\`${inner}\`](classmate-ref://${fileIndex}?i)`;
	}
	const single = /^[A-Za-z_]\w*$/.exec(inner);
	const qualified = /^[A-Za-z_]\w*(?:::[A-Za-z_]\w*)+$/.exec(inner);
	if (!single && !qualified) {
		return segment; // 多对象代码(带参调用等)不链
	}
	const symbol = single ? single[0] : inner.split('::').pop()!;
	if (inner.split('::')[0] === 'std') {
		return segment; // std:: 标准库符号不链用户代码
	}
	if (!uniqueSymbols.has(symbol)) {
		return segment;
	}
	const refIndex = references.findIndex((reference) => reference.symbol === symbol);
	if (refIndex === -1) {
		return segment;
	}
	return `[\`${inner}\`](classmate-ref://${refIndex}?i)`;
}

export interface ReferenceLinkLayers {
	/** 模型标记生成的链接数(证词层)。 */
	modelMarkedLinks: number;
	/** 渲染层保守补链数(展示层)。 */
	inferredLinks: number;
}

/** 分层度量:两种后缀形态互斥,互不冒充。 */
export function summarizeReferenceLinks(markdown: string): ReferenceLinkLayers {
	return {
		modelMarkedLinks: (markdown.match(/\]\(classmate-ref:\/\/\d+\)/g) ?? []).length,
		inferredLinks: (markdown.match(/\]\(classmate-ref:\/\/\d+\?i\)/g) ?? []).length,
	};
}
