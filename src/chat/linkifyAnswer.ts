import type { ChatReference } from './types';

interface Segment {
	text: string;
	kind: 'plain' | 'code-block' | 'inline-code' | 'link';
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function basename(uri: string): string {
	return uri.split(/[\\/]/).pop() ?? uri;
}

/** 与 react-markdown 默认白名单一致,保证自定义消毒不改变其余行为。 */
const SAFE_PROTOCOL = /^(https?|ircs?|mailto|xmpp)$/i;

/**
 * react-markdown 的 urlTransform:放行 classmate-ref://,其余交给默认安全规则
 * (未知协议置空,避免 LLM 输出里的可疑 scheme 进入 DOM)。
 */
export function transformReferenceUrl(value: string): string {
	if (value.startsWith('classmate-ref://')) {
		return value;
	}
	const colon = value.indexOf(':');
	const questionMark = value.indexOf('?');
	const numberSign = value.indexOf('#');
	const slash = value.indexOf('/');
	if (
		colon === -1 ||
		(slash !== -1 && colon > slash) ||
		(questionMark !== -1 && colon > questionMark) ||
		(numberSign !== -1 && colon > numberSign) ||
		SAFE_PROTOCOL.test(value.slice(0, colon))
	) {
		return value;
	}
	return '';
}

/** markdown 感知切分:代码块、行内代码、已有链接原样保留,其余为正文。 */
function tokenizeMarkdown(content: string): Segment[] {
	const segments: Segment[] = [];
	let i = 0;
	while (i < content.length) {
		if (content.startsWith('```', i)) {
			const end = content.indexOf('```', i + 3);
			if (end === -1) {
				segments.push({ text: content.slice(i), kind: 'code-block' });
				break;
			}
			segments.push({ text: content.slice(i, end + 3), kind: 'code-block' });
			i = end + 3;
			continue;
		}
		if (content[i] === '`') {
			const end = content.indexOf('`', i + 1);
			if (end === -1) {
				segments.push({ text: content.slice(i), kind: 'inline-code' });
				break;
			}
			segments.push({ text: content.slice(i, end + 1), kind: 'inline-code' });
			i = end + 1;
			continue;
		}
		if (content[i] === '[') {
			const close = content.indexOf('](', i);
			if (close !== -1) {
				const urlEnd = content.indexOf(')', close + 2);
				if (urlEnd !== -1) {
					segments.push({ text: content.slice(i, urlEnd + 1), kind: 'link' });
					i = urlEnd + 1;
					continue;
				}
			}
		}
		let next = i + 1;
		while (next < content.length) {
			const ch = content[next];
			if (ch === '`' || ch === '[' || content.startsWith('```', next)) {
				break;
			}
			next++;
		}
		segments.push({ text: content.slice(i, next), kind: 'plain' });
		i = next;
	}
	return segments;
}

interface LinkRange {
	start: number;
	end: number;
	label: string;
	refIndex: number;
}

function linkifyPlain(
	text: string,
	references: ChatReference[],
	uniqueSymbols: Set<string>
): string {
	const ranges: LinkRange[] = [];
	references.forEach((reference, index) => {
		if (reference.startLine !== undefined) {
			const file = basename(reference.uri);
			const pattern = new RegExp(`\\b${escapeRegExp(file)}:${reference.startLine}\\b`, 'g');
			let m: RegExpExecArray | null;
			while ((m = pattern.exec(text)) !== null) {
				ranges.push({
					start: m.index,
					end: m.index + m[0].length,
					label: m[0],
					refIndex: index,
				});
			}
		}
		if (reference.symbol && uniqueSymbols.has(reference.symbol)) {
			const pattern = new RegExp(`\\b${escapeRegExp(reference.symbol)}\\b`, 'g');
			let m: RegExpExecArray | null;
			while ((m = pattern.exec(text)) !== null) {
				ranges.push({
					start: m.index,
					end: m.index + m[0].length,
					label: m[0],
					refIndex: index,
				});
			}
		}
	});
	if (ranges.length === 0) {
		return text;
	}
	ranges.sort((a, b) => a.start - b.start || b.end - a.end);
	const accepted: LinkRange[] = [];
	for (const range of ranges) {
		const last = accepted[accepted.length - 1];
		if (last && range.start < last.end) {
			continue; // 与已接受区间重叠(如 文件:行 优先于裸符号)
		}
		accepted.push(range);
	}
	let out = '';
	let cursor = 0;
	for (const range of accepted) {
		out += text.slice(cursor, range.start);
		out += `[${range.label}](classmate-ref://${range.refIndex})`;
		cursor = range.end;
	}
	out += text.slice(cursor);
	return out;
}

/** 行内代码段:内容恰好是单个可链符号时,去掉反引号渲染成链接;否则保持代码样式。 */
function linkifyInlineCode(
	segment: string,
	references: ChatReference[],
	uniqueSymbols: Set<string>
): string {
	const inner = segment.slice(1, -1).trim();
	if (!/^[A-Za-z_]\w*$/.test(inner) || !uniqueSymbols.has(inner)) {
		return segment;
	}
	const refIndex = references.findIndex((reference) => reference.symbol === inner);
	if (refIndex === -1) {
		return segment;
	}
	return `[${inner}](classmate-ref://${refIndex})`;
}

/**
 * 把回答正文里的代码提及变成内联链接(仅渲染层使用,不改动原始内容)。
 * 跳过代码块与已有链接;行内代码里"恰好是单个符号"的提及也会链接;
 * 裸符号只在目标唯一时链接(宁缺毋滥)。
 */
export function linkifyAnswer(content: string, references: ChatReference[]): string {
	if (references.length === 0) {
		return content;
	}
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
			if (segment.kind === 'plain') {
				return linkifyPlain(segment.text, references, uniqueSymbols);
			}
			if (segment.kind === 'inline-code') {
				return linkifyInlineCode(segment.text, references, uniqueSymbols);
			}
			return segment.text;
		})
		.join('');
}
