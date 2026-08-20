import type { CppSymbol } from '../parser/cppWorkspaceIndex';
import { symbolStateSentence } from './answerGroundingValidator';

/** 兜底提示里最多列出的符号数,防止大文件把提示撑成长清单。 */
const MAX_LISTED_SYMBOLS = 6;

const FUNCTION_LIKE_KINDS = new Set<CppSymbol['kind']>([
	'function',
	'method',
	'constructor',
	'destructor',
	'operator',
]);

/**
 * 模型调用失败重试后仍失败时的本地事实提示(recovery_fallback)。
 * 全部内容由冻结快照的 Tree-sitter 事实确定性生成,不依赖任何模型输出;
 * 含道歉措辞、不含内部术语(与教学更正文案规范一致)。
 * 无符号索引时退化为引导学生核对当前文件的短提示。
 */
export function buildRecoveryLocalHint(input: {
	symbols?: readonly CppSymbol[];
	activeFile?: string;
}): string {
	const symbols = [...(input.symbols ?? [])]
		.sort((a, b) => {
			const functionFirst = Number(FUNCTION_LIKE_KINDS.has(b.kind))
				- Number(FUNCTION_LIKE_KINDS.has(a.kind));
			return functionFirst !== 0
				? functionFirst
				: a.file.localeCompare(b.file) || a.startLine - b.startLine;
		});
	const lines: string[] = [
		'抱歉，我这边连续两次没能完成回答生成，先不猜任何结论。',
	];
	if (symbols.length > 0) {
		lines.push('从当前文件能确定的事实：');
		lines.push(...symbols
			.slice(0, MAX_LISTED_SYMBOLS)
			.map((symbol) => `- ${symbolStateSentence(symbol)}`));
		if (symbols.length > MAX_LISTED_SYMBOLS) {
			lines.push(`-（工作区其余 ${symbols.length - MAX_LISTED_SYMBOLS} 个符号此处略）`);
		}
	} else {
		lines.push(input.activeFile
			? `你可以先打开 ${input.activeFile} 核对当前内容，我恢复后马上继续。`
			: '你可以先核对当前打开的文件内容，我恢复后马上继续。');
	}
	lines.push('稍后把问题再发一次，我会基于这个状态继续。');
	return lines.join('\n');
}
