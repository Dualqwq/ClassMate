import type { LoadedWorkspaceItem } from '../workspace/types';

/** 提取节点返回的单个候选,经 sanitize 校验后保留。 */
export interface ExtractedReference {
	f: string;
	s?: string;
	l?: number;
	k?: 'def' | 'call' | 'ref';
}

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
	return definitionPattern(symbol).test(content);
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
		if (!defLines.has(lineAt(content, m.index))) {
			return true;
		}
	}
	return false;
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

/** 轻量符号扫描:收集"标识符(" 形态的名字,去重并排除控制关键字。 */
export function scanSymbols(content: string, limit = 30): string[] {
	const seen = new Set<string>();
	const symbols: string[] = [];
	const pattern = /\b([A-Za-z_]\w*)\s*\(/g;
	let m: RegExpExecArray | null;
	while ((m = pattern.exec(content)) !== null) {
		const name = m[1];
		if (CONTROL_KEYWORDS.has(name) || seen.has(name)) {
			continue;
		}
		seen.add(name);
		symbols.push(name);
		if (symbols.length >= limit) {
			break;
		}
	}
	return symbols;
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
		}
		if (s === undefined && l === undefined) {
			continue; // 什么都没指
		}
		const key = `${candidate.f}|${s ?? ''}|${l ?? ''}|${k ?? ''}`;
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		result.push({ f: candidate.f, s, l, k });
	}
	return result;
}
