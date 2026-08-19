import type { ChatReference, ReferenceKind } from './types';
import type { CppSymbol } from '../parser/cppWorkspaceIndex';

/**
 * 引用契约(7.6):程序把候选目标(targetId)随提示词给模型,模型在正文
 * 具体提及处放 {{ref:targetId|显示名}} 标记;多行代码块在闭合栅栏后一行放
 * {{refblock:targetId,...}} 报告来源(用户要求 2026-08-19)。本模块把标记
 * 确定性转换为内联代码链接、来源行与引用清单。普通词没有标记,永远不会
 * 被链接。模型自编的裸 classmate-ref:// 链接(模仿历史所致)会被剥成
 * 行内代码文字,不产生死链。
 */
export interface ReferenceTarget {
	targetId: string;
	file: string;
	name: string;
	kind: CppSymbol['kind'];
	container?: string;
	startLine: number;
	endLine: number;
}

export interface FinalizedAnswer {
	/** 标记已替换为链接/行内代码的 Markdown;不含任何 {{ref:/{{refblock: 残留。 */
	markdown: string;
	references: ChatReference[];
	issues: Array<{
		kind: 'unknown_target' | 'stale_hash' | 'missing_root';
		targetId: string;
	}>;
}

export function buildReferenceTargetCatalog(
	symbols: CppSymbol[]
): { targets: ReferenceTarget[] } {
	return {
		targets: symbols.map((symbol) => ({
			targetId: symbol.targetId,
			file: symbol.file,
			name: symbol.name,
			kind: symbol.kind,
			container: symbol.container,
			startLine: symbol.startLine,
			endLine: symbol.endLine,
		})),
	};
}

const MARKER_PATTERN = /\{\{ref:([^|}]+)\|([^}]+)\}\}/g;
/** 残缺标记:有 {{ref: 开头但未在合理长度内闭合,按普通文本处理。 */
const UNCLOSED_MARKER_PATTERN = /\{\{ref:[^}]{0,120}$/;
/** 代码块闭合栅栏后一行内的来源标记(标准位置)。 */
const REFBLOCK_PATTERN = /(```[ \t]*\n)\{\{refblock:([^}\s]+)\}\}/g;
/** 散置形态:独立成行但与栅栏隔了空行/其他内容的来源标记,就地转来源行。 */
const STRAY_REFBLOCK_PATTERN = /^[ \t]*\{\{refblock:([^}\s]+)\}\}[ \t]*\n?/gm;
/** 残缺 refblock(未闭合):兜底清扫,不得进入渲染文本。 */
const MALFORMED_REFBLOCK_PATTERN = /\{\{refblock:[^}\n]{0,200}\n?/g;
/** 模型自编的裸引用链接(无对应标记):剥链接保文字。 */
const BARE_REF_LINK_PATTERN = /\[(`[^`]*`|[^[\]]*)\]\(classmate-ref:\/\/\d+(?:\?i)?\)/g;

const KIND_BY_SYMBOL: Record<CppSymbol['kind'], ReferenceKind> = {
	class: 'type',
	function: 'func',
	method: 'func',
	constructor: 'func',
	destructor: 'func',
	operator: 'func',
	field: 'var',
	macro: 'macro',
};

interface FinalizeContext {
	byTargetId: Map<string, CppSymbol>;
	fileHashes: Map<string, string>;
	root: string | undefined;
	references: ChatReference[];
	issues: FinalizedAnswer['issues'];
}

function symbolToReference(symbol: CppSymbol, workspaceRootUri: string): ChatReference {
	// URI 编码对齐 vscode.Uri.joinPath:根去尾斜杠,相对路径逐段 encodeURIComponent,
	// 空格等特殊字符在链接里保持 %XX 形态,打开时与旧提取路径行为一致。
	const root = workspaceRootUri.replace(/\/+$/, '');
	const relative = symbol.file
		.split('/')
		.map((segment) => encodeURIComponent(segment))
		.join('/');
	return {
		label: symbol.name,
		uri: `${root}/${relative}`,
		startLine: symbol.startLine,
		endLine: symbol.endLine,
		symbol: symbol.name,
		kind: KIND_BY_SYMBOL[symbol.kind],
	};
}

/** 目标可用性三查:存在 → hash 新鲜 → 根路径可用。issue 字段存在即不可用。 */
type TargetOutcome =
	| { symbol: CppSymbol }
	| { issue: FinalizedAnswer['issues'][0]['kind'] };

function checkTarget(context: FinalizeContext, targetId: string): TargetOutcome {
	const symbol = context.byTargetId.get(targetId.trim());
	if (!symbol) {
		return { issue: 'unknown_target' };
	}
	if (context.fileHashes.get(symbol.file) === undefined) {
		return { issue: 'stale_hash' };
	}
	if (!context.root) {
		// 无真实工作区根路径时宁可降级,也不产出指向不存在文件的链接。
		return { issue: 'missing_root' };
	}
	return { symbol };
}

/** 已入清单的符号复用索引;新符号追加。调用前需确认目标可用。 */
function referenceIndexFor(context: FinalizeContext, symbol: CppSymbol): number {
	const refIndex = context.references.findIndex((reference) =>
		reference.symbol === symbol.name && reference.startLine === symbol.startLine
	);
	if (refIndex !== -1) {
		return refIndex;
	}
	context.references.push(symbolToReference(symbol, context.root!));
	return context.references.length - 1;
}

function codeSpan(label: string): string {
	return label.startsWith('`') && label.endsWith('`') && label.length > 1
		? label
		: `\`${label}\``;
}

/** 把来源标记的目标清单渲染为可见来源行;全部无效时返回空串(原样省略)。 */
function renderSourceLine(context: FinalizeContext, list: string): string {
	const parts = list.split(',').map((part) => part.trim()).filter(Boolean);
	const rendered: string[] = [];
	for (const targetId of parts) {
		const outcome = checkTarget(context, targetId);
		if ('issue' in outcome) {
			context.issues.push({ kind: outcome.issue, targetId });
			continue; // 坏目标:来源行里直接省略,不生成链接
		}
		const { symbol } = outcome;
		rendered.push(
			`[\`${symbol.name}\`](classmate-ref://${referenceIndexFor(context, symbol)})`
				+ ` · ${symbol.file}:${symbol.startLine}–${symbol.endLine}`
		);
	}
	return rendered.length === 0 ? '' : `*来源: ${rendered.join(' · ')}*\n`;
}

export function finalizeAnswerReferences(
	answer: string,
	symbols: CppSymbol[],
	fileHashes: Map<string, string>,
	options?: { workspaceRootUri?: string }
): FinalizedAnswer {
	const context: FinalizeContext = {
		byTargetId: new Map(symbols.map((symbol) => [symbol.targetId, symbol])),
		fileHashes,
		root: options?.workspaceRootUri,
		references: [],
		issues: [],
	};

	const markdown = answer
		// 1) 行内标记 → 链接/行内代码
		.replace(MARKER_PATTERN, (_match, targetId: string, label: string) => {
			const outcome = checkTarget(context, targetId);
			if ('issue' in outcome) {
				context.issues.push({ kind: outcome.issue, targetId });
				return `\`${label}\``;
			}
			return `[\`${label}\`](classmate-ref://${referenceIndexFor(context, outcome.symbol)})`;
		})
		// 2) 代码块来源标记 → 可见来源行(标准位置 + 散置形态就地转换)
		.replace(REFBLOCK_PATTERN, (_match, fence: string, list: string) =>
			`${fence}${renderSourceLine(context, list)}`)
		.replace(STRAY_REFBLOCK_PATTERN, (_match, list: string) =>
			renderSourceLine(context, list))
		// 3) 模型自编的裸引用链接 → 剥链接保文字(死链防线)。
		//    仅剥本轮标记未生成过的索引;标记刚生成的链接在正文里,不能误伤。
		.replace(BARE_REF_LINK_PATTERN, (match, label: string, _offset: number, whole: string) => {
			void whole;
			const index = Number(/classmate-ref:\/\/(\d+)/.exec(match)?.[1]);
			return index < context.references.length ? match : codeSpan(label);
		})
		// 4) 残缺(未闭合)标记不得进入渲染文本
		.replace(UNCLOSED_MARKER_PATTERN, (match) => match.replace('{{ref:', '`').concat('`'))
		.replace(MALFORMED_REFBLOCK_PATTERN, '');

	return { markdown, references: context.references, issues: context.issues };
}
