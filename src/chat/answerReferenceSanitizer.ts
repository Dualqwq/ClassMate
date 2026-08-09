import type { LoadedWorkspaceItem } from '../workspace/types';
import type { ReferenceKind } from './types';

/** 提取节点返回的单个候选,经 sanitize 校验后保留。 */
export interface ExtractedReference {
	f: string;
	s?: string;
	l?: number;
	k?: 'def' | 'call' | 'ref';
	t?: ReferenceKind;
}

export interface ReferenceSymbolInfo {
	name: string;
	lines: Array<{ line: number; text: string }>;
}

export interface ReferenceExtractionFile {
	path: string;
	symbols: ReferenceSymbolInfo[];
}

const MAX_SYMBOLS_PER_FILE = 20;
const MAX_LINES_PER_SYMBOL = 8;
const MAX_LINE_ENTRIES_PER_FILE = 60;
const MAX_LINE_TEXT_LENGTH = 160;

export const LINE_CONSISTENCY_WINDOW = 5;

const CONTROL_KEYWORDS = new Set([
	'if',
	'for',
	'while',
	'switch',
	'return',
	'catch',
	'sizeof',
	'throw',
	'new',
	'delete',
	'decltype',
	'static_cast',
	'dynamic_cast',
	'const_cast',
	'reinterpret_cast',
	'alignof',
	'typeid',
	'noexcept',
	'require',
	'co_await',
	'co_return',
	'co_yield',
]);

export function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function hasSymbolOccurrence(content: string, symbol: string): boolean {
	return new RegExp(`\\b${escapeRegExp(symbol)}\\b`).test(content);
}

function definitionPattern(symbol: string, flags = 'm'): RegExp {
	return new RegExp(
		`(?:^|\\n)\\s*(?:template\\s*<[^>]*>\\s*)?[A-Za-z_][\\w:<>*&\\[\\],\\s]*\\b${escapeRegExp(symbol)}\\s*\\([^;{}]*\\)\\s*(?:\\{|;|$)`,
		flags
	);
}

export function hasDefinitionLike(content: string, symbol: string): boolean {
	if (definitionPattern(symbol).test(content)) {
		return true;
	}
	// 类/结构体/枚举定义形态:class Player {、struct Node : ...、enum class Color {。
	return new RegExp(
		`\\b(?:struct|union|class|enum(?:\\s+class)?)\\s+${escapeRegExp(symbol)}\\b`
	).test(content);
}

function lineAt(content: string, index: number): number {
	let line = 1;
	for (let i = 0; i < index && i < content.length; i++) {
		if (content.charCodeAt(i) === 10) {
			line++;
		}
	}
	return line;
}

export function hasCallLike(content: string, symbol: string): boolean {
	const defLines = new Set<number>();
	const defPattern = definitionPattern(symbol, 'gm');
	let m: RegExpExecArray | null;
	while ((m = defPattern.exec(content)) !== null) {
		defLines.add(lineAt(content, m.index));
	}
	const callPattern = new RegExp(`\\b${escapeRegExp(symbol)}\\s*\\(`, 'g');
	while ((m = callPattern.exec(content)) !== null) {
		if (isMemberInitListOccurrence(content, m.index)) {
			continue; // 构造函数初始化列表里的 attack_(a) 不是函数调用
		}
		if (!defLines.has(lineAt(content, m.index))) {
			return true;
		}
	}
	return false;
}

/**
 * 判断匹配位置是否位于构造函数初始化列表内(如 `: name_(std::move(name))` 或
 * `,attack_(a)`)。初始化列表里 `member(...)` 是成员初始化,不是函数调用。
 * 判定依据:匹配位置之前最近一条语句边界({ } ; 或文件头)之后存在"构造签名 ): "。
 */
function isMemberInitListOccurrence(content: string, index: number): boolean {
	const start =
		Math.max(
			content.lastIndexOf('{', index - 1),
			content.lastIndexOf('}', index - 1),
			content.lastIndexOf(';', index - 1)
		) + 1;
	const before = content.slice(start, index);
	return /\)\s*:\s*[^;{}]*$/.test(before) || /\n\s*:\s*[^;{}]*$/.test(before);
}

/**
 * 语义类型判定:本地高置信证据优先(类/结构体/枚举 → type,定义/调用形 → func,
 * 尾下划线成员变量命名约定 → var,全大写 → macro),LLM 提议兜底。
 */
export function inferSymbolKind(
	content: string,
	symbol: string,
	proposed?: ReferenceKind
): ReferenceKind {
	const typePattern = new RegExp(
		`\\b(?:struct|union|class|enum(?:\\s+class)?)\\s+${escapeRegExp(symbol)}\\b`
	);
	if (typePattern.test(content)) {
		return 'type';
	}
	if (hasDefinitionLike(content, symbol) || hasCallLike(content, symbol)) {
		return 'func';
	}
	if (/^[a-z_][a-zA-Z0-9_]*_$/.test(symbol)) {
		return 'var'; // name_/attack_ 这类尾下划线是常见成员变量命名约定
	}
	if (/^[A-Z][A-Z0-9_]*$/.test(symbol)) {
		return 'macro';
	}
	return proposed ?? 'other';
}

export function hasSymbolNearLine(
	content: string,
	symbol: string,
	line: number,
	window = LINE_CONSISTENCY_WINDOW
): boolean {
	const lines = content.split('\n');
	const re = new RegExp(`\\b${escapeRegExp(symbol)}\\b`);
	const start = Math.max(0, line - 1 - window);
	const end = Math.min(lines.length, line - 1 + window + 1);
	for (let i = start; i < end; i++) {
		if (re.test(lines[i])) {
			return true;
		}
	}
	return false;
}

/** 符号是否精确出现在指定 1-based 行。 */
export function hasSymbolOnLine(content: string, symbol: string, line: number): boolean {
	const text = content.split('\n')[line - 1];
	if (text === undefined) {
		return false;
	}
	return new RegExp(`\\b${escapeRegExp(symbol)}\\b`).test(text);
}

/** 轻量符号扫描:收集"标识符(" 与"class/struct/enum 类型名"形态的名字,去重并排除控制关键字。 */
export function scanSymbols(content: string, limit = 30): string[] {
	const seen = new Set<string>();
	const symbols: string[] = [];
	const functionPattern = /\b([A-Za-z_]\w*)\s*\(/g;
	const typePattern =
		/\b(?:struct|union|class|enum(?:\s+class)?)\s+([A-Za-z_]\w*)\s*(?:\{|:|\n)/g;
	let m: RegExpExecArray | null;
	const collect = (name: string): void => {
		if (name.length < 2 || CONTROL_KEYWORDS.has(name) || seen.has(name)) {
			return;
		}
		seen.add(name);
		symbols.push(name);
	};
	while ((m = functionPattern.exec(content)) !== null) {
		collect(m[1]);
		if (symbols.length >= limit) {
			return symbols;
		}
	}
	while ((m = typePattern.exec(content)) !== null) {
		collect(m[1]);
		if (symbols.length >= limit) {
			break;
		}
	}
	return symbols;
}

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

/**
 * 构造消歧用的极简清单:每个代码文件 + 符号 → 出现行号+行文本。
 * 只包含 kind === 'code' 的文件,避免把 README/题面里的词误当代码符号。
 */
export function buildReferenceExtractionInput(
	loadedItems: LoadedWorkspaceItem[]
): ReferenceExtractionFile[] {
	const files: ReferenceExtractionFile[] = [];
	for (const item of loadedItems) {
		if (item.kind !== 'code') {
			continue;
		}
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

/**
 * 确定性校验:文件白名单 → 符号存在性 → 行号一致性(±5) → kind 轻量校验。
 * 宁缺毋滥:任何一步不满足就丢弃或回退,不产生可疑链接。
 */
export function sanitizeAnswerReferences(
	candidates: ExtractedReference[],
	loadedItems: LoadedWorkspaceItem[]
): ExtractedReference[] {
	const itemsByPath = new Map(loadedItems.map((item) => [item.path, item]));
	const seen = new Set<string>();
	const result: ExtractedReference[] = [];
	for (const candidate of candidates) {
		const item = itemsByPath.get(candidate.f);
		if (!item) {
			continue; // 白名单外的文件
		}
		const content = item.content;
		let s = candidate.s;
		let l = candidate.l;
		let k = candidate.k;
		let t = candidate.t;

		if (l !== undefined) {
			const lineCount = content.length === 0 ? 1 : content.split('\n').length;
			l = Math.min(Math.max(1, Math.round(l)), lineCount);
			if (s) {
				// 清单已精确给出符号的出现行:l 必须命中该符号所在的行,否则回退符号定位。
				if (!hasSymbolOnLine(content, s, l)) {
					l = undefined; // 行号与符号不一致,回退符号定位
				}
			} else {
				const lineText = content.split('\n')[l - 1] ?? '';
				if (!lineText.trim()) {
					l = undefined; // 空行不可信
				}
			}
		}
		if (s) {
			if (!hasSymbolOccurrence(content, s)) {
				continue; // 文件里没有这个符号
			}
			if (k === 'def' && !hasDefinitionLike(content, s)) {
				k = undefined;
			}
			if (k === 'call' && !hasCallLike(content, s)) {
				k = undefined;
			}
			if (t === 'std' && !s.startsWith('std::')) {
				t = undefined; // 无 std:: 前缀的裸符号不算标准库
			}
			t = inferSymbolKind(content, s, t);
		}
		if (s === undefined && l === undefined) {
			continue; // 什么都没指
		}
		const key = `${candidate.f}|${s ?? ''}|${l ?? ''}|${k ?? ''}`;
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		result.push({ f: candidate.f, s, l, k, t });
	}
	return result;
}
