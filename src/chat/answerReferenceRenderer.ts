import type { ChatReference } from './types';
import { tokenizeMarkdown } from './linkifyAnswer';

/**
 * 引用契约的展示层(v2 计划):证词层(answerReferences)只由模型标记生成;
 * 本模块在渲染时对"已是行内代码 + 候选目录中唯一匹配"的提及保守补链,
 * 链接带 ?i 后缀,与模型标记链接(classmate-ref://N)区分计数。
 * 红线:普通文字(无行内代码包裹)永远不是补链候选;同名不唯一不补;
 * std:: 前缀不补。补链结果不回写 answerReferences。
 */
export function inferenceLinkifyAnswer(
	content: string,
	references: ChatReference[]
): string {
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
			// 红线:普通文字段不做任何推断,原样返回。
			if (segment.kind !== 'inline-code') {
				return segment.text;
			}
			return linkifyInlineCode(segment.text, references, uniqueSymbols);
		})
		.join('');
}

/** 行内代码段:内容恰好是单个可链符号时补 inferred 链接;否则保持代码样式。 */
function linkifyInlineCode(
	segment: string,
	references: ChatReference[],
	uniqueSymbols: Set<string>
): string {
	const inner = segment.slice(1, -1).trim();
	const single = /^[A-Za-z_]\w*$/.exec(inner);
	const qualified = /^[A-Za-z_]\w*(?:::[A-Za-z_]\w*)+$/.exec(inner);
	if (!single && !qualified) {
		return segment;
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
