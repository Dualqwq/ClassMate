import type { ChatReference, ReferenceKind } from './types';
import type { CppSymbol } from '../parser/cppWorkspaceIndex';

/**
 * 引用契约(7.6):程序把候选目标(targetId)随提示词给模型,模型在正文
 * 具体提及处放 {{ref:targetId|显示名}} 标记;本模块把标记确定性转换为
 * 内联代码链接与引用清单。普通词没有标记,永远不会被链接。
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
	/** 标记已替换为链接/行内代码的 Markdown;不含任何 {{ref: 残留。 */
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

function symbolToReference(
	symbol: CppSymbol,
	workspaceRootUri: string
): ChatReference {
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

export function finalizeAnswerReferences(
	answer: string,
	symbols: CppSymbol[],
	fileHashes: Map<string, string>,
	options?: { workspaceRootUri?: string }
): FinalizedAnswer {
	const byTargetId = new Map(symbols.map((symbol) => [symbol.targetId, symbol]));
	const root = options?.workspaceRootUri;
	const references: ChatReference[] = [];
	const issues: FinalizedAnswer['issues'] = [];

	const markdown = answer.replace(MARKER_PATTERN, (_match, targetId: string, label: string) => {
		const symbol = byTargetId.get(targetId.trim());
		if (!symbol) {
			issues.push({ kind: 'unknown_target', targetId });
			return `\`${label}\``;
		}
		if (fileHashes.get(symbol.file) === undefined) {
			issues.push({ kind: 'stale_hash', targetId });
			return `\`${label}\``;
		}
		if (!root) {
			// 无真实工作区根路径时宁可降级为行内代码,也不产出
			// 指向不存在文件的链接(点击只会失败)。
			issues.push({ kind: 'missing_root', targetId });
			return `\`${label}\``;
		}
		const refIndex = references.findIndex((reference) =>
			reference.symbol === symbol.name && reference.startLine === symbol.startLine
		);
		if (refIndex === -1) {
			references.push(symbolToReference(symbol, root!));
			return `[\`${label}\`](classmate-ref://${references.length - 1})`;
		}
		return `[\`${label}\`](classmate-ref://${refIndex})`;
	});

	// 兜底:残缺(未闭合)标记不得进入渲染文本。
	const sealed = markdown.replace(
		UNCLOSED_MARKER_PATTERN,
		(match) => match.replace('{{ref:', '`').concat('`')
	);

	return { markdown: sealed, references, issues };
}
