import * as vscode from 'vscode';
import type { ChatReference } from './types';
import type { LoadedWorkspaceItem } from '../workspace/types';
import type { GraphModelClient } from '../graph/modelClient';
import { AnswerReferencePromptBuilder } from '../prompts/answerReferencePromptBuilder';
import { answerReferencesWireSchema, parseJsonObject } from './answerReferenceSchema';
import {
	escapeRegExp,
	scanSymbols,
	sanitizeAnswerReferences,
	type ExtractedReference,
} from './answerReferenceSanitizer';

const CODE_MENTION_HINT =
	/(?:\.(?:cpp|c|h|hpp|cc|cxx|C|H)\b)|(?:第\s*\d+\s*行)|(?::\s*\d+\b)|(\b[A-Za-z_]\w*\s*\()/;

function hasCodeMentionHint(answer: string): boolean {
	return CODE_MENTION_HINT.test(answer);
}

export interface ReferenceExtractionFile {
	path: string;
	symbols: ReferenceSymbolInfo[];
}

export interface ReferenceSymbolInfo {
	name: string;
	lines: Array<{ line: number; text: string }>;
}

const MAX_SYMBOLS_PER_FILE = 20;
const MAX_LINES_PER_SYMBOL = 8;
const MAX_LINE_ENTRIES_PER_FILE = 60;
const MAX_LINE_TEXT_LENGTH = 160;

/** 扫描一个符号在文件里的出现行(1-based)+ 该行文本,供 LLM 精确选行。 */
export function scanSymbolLines(
	content: string,
	symbol: string,
	limit = MAX_LINES_PER_SYMBOL
): Array<{ line: number; text: string }> {
	const lines = content.split('\n');
	const re = new RegExp(`\\b${escapeRegExp(symbol)}\\b`);
	const result: Array<{ line: number; text: string }> = [];
	for (let i = 0; i < lines.length && result.length < limit; i++) {
		if (re.test(lines[i])) {
			const text = lines[i].trim();
			result.push({
				line: i + 1,
				text: text.length > MAX_LINE_TEXT_LENGTH
					? `${text.slice(0, MAX_LINE_TEXT_LENGTH)}…`
					: text,
			});
		}
	}
	return result;
}

/** 构造消歧用的极简清单:每个冻结文件 + 符号 → 出现行号+行文本。 */
export function buildReferenceExtractionInput(
	loadedItems: LoadedWorkspaceItem[]
): ReferenceExtractionFile[] {
	const files: ReferenceExtractionFile[] = [];
	for (const item of loadedItems) {
		const symbols: ReferenceSymbolInfo[] = [];
		let lineEntries = 0;
		for (const name of scanSymbols(item.content, MAX_SYMBOLS_PER_FILE)) {
			const lines = scanSymbolLines(item.content, name);
			if (lines.length === 0) {
				continue;
			}
			symbols.push({ name, lines });
			lineEntries += lines.length;
			if (lineEntries >= MAX_LINE_ENTRIES_PER_FILE) {
				break;
			}
		}
		files.push({ path: item.path, symbols });
	}
	return files;
}

export function buildAnswerReference(
	ref: ExtractedReference,
	workspaceRoot: vscode.Uri | undefined,
	loadedItems: LoadedWorkspaceItem[]
): ChatReference | undefined {
	const item = loadedItems.find((entry) => entry.path === ref.f);
	if (!item || !workspaceRoot) {
		return undefined;
	}
	const uri = vscode.Uri.joinPath(workspaceRoot, ref.f).toString();
	const label = ref.l !== undefined ? `${ref.f}:${ref.l}` : ref.s ?? ref.f;
	return {
		label,
		uri,
		startLine: ref.l,
		symbol: ref.s,
	};
}

/** 预过滤:引用文件已不存在的丢弃(避免历史会话出现失效链接)。 */
async function filterExistingReferences(references: ChatReference[]): Promise<ChatReference[]> {
	const result: ChatReference[] = [];
	for (const reference of references) {
		try {
			await vscode.workspace.fs.stat(vscode.Uri.parse(reference.uri));
			result.push(reference);
		} catch {
			// 文件已不存在,丢弃。
		}
	}
	return result;
}

export interface ExtractAnswerReferencesOptions {
	model: GraphModelClient;
	workspaceRoot?: vscode.Uri;
	signal?: AbortSignal;
}

/**
 * 回答完成后的引用提取:粗筛短路 → jsonMode 小调用 → 确定性校验 → 预过滤。
 * 任何一步失败都安全降级为空(不产生链接,不阻断回答)。
 */
export async function extractAnswerReferences(
	answer: string,
	loadedItems: LoadedWorkspaceItem[],
	options: ExtractAnswerReferencesOptions
): Promise<ChatReference[]> {
	if (loadedItems.length === 0 || !hasCodeMentionHint(answer)) {
		return [];
	}
	const files = buildReferenceExtractionInput(loadedItems);
	const messages = new AnswerReferencePromptBuilder().build({ answer, files });
	let candidates: ExtractedReference[] = [];
	try {
		const completion = await options.model.complete(messages, {
			label: 'extract_references',
			temperature: 0,
			maxTokens: 600,
			jsonMode: true,
			thinkingMode: 'disabled',
			signal: options.signal,
		});
		candidates = answerReferencesWireSchema.parse(parseJsonObject(completion.content)).r;
	} catch {
		return [];
	}
	const sanitized = sanitizeAnswerReferences(candidates, loadedItems);
	const references: ChatReference[] = [];
	for (const ref of sanitized) {
		const built = buildAnswerReference(ref, options.workspaceRoot, loadedItems);
		if (built) {
			references.push(built);
		}
	}
	return filterExistingReferences(references);
}
