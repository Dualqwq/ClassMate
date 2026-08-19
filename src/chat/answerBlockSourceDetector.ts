import type { CppSymbol } from '../parser/cppWorkspaceIndex';

/**
 * 程序侧块来源自查(7.6,用户拍板 2026-08-19):模型不再承担 refblock,
 * 由本模块对回答中的每个栅栏代码块做确定性溯源——块内有效代码行(去空白、
 * 剔除纯符号噪声行)在冻结工作区已加载代码文件的**函数行范围**内逐行查找,
 * 命中率足够(≥MIN_HITS 且覆盖块的有效行)即归到该函数;无覆盖符号时归文件。
 *
 * 行集包含(顺序无关)而非连续子序列:模型复述代码时常改花括号风格/行序,
 * 连续相等匹配会大量漏配。误配防线:命中率阈值 + 多候选时宁缺毋滥。
 *
 * 第一目的是历史清洗与错误过滤(证词数据):
 * - 块来源文件并入该轮 referenceFiles,历史裁剪的文件归属升级为实证绑定;
 * - file+targetId 结构化证词供 7.7 校验消费;
 * - 不渲染、不进 answerReferences,与模型标记证词分层。
 */
export interface BlockSource {
	blockIndex: number;
	/** 唯一命中(文件+函数)。 */
	status: 'unique';
	file: string;
	targetId: string;
}

export interface BlockFileSource {
	blockIndex: number;
	/** 仅文件级唯一(无覆盖符号,如类骨架/头文件行)。 */
	status: 'unique-file';
	file: string;
	targetId?: undefined;
}

export interface BlockAmbiguousSource {
	blockIndex: number;
	status: 'ambiguous';
	file?: undefined;
	targetId?: undefined;
}

export interface BlockNoSource {
	blockIndex: number;
	status: 'none';
	file?: undefined;
	targetId?: undefined;
}

export type AnswerBlockSource = BlockSource | BlockFileSource | BlockAmbiguousSource | BlockNoSource;

const FENCED_BLOCK_PATTERN = /```[^\n]*\n([\s\S]*?)```/g;
/** 纯符号噪声行:花括号/分号/括号组合,不参与签名。 */
const NOISE_LINE = /^[{}()[\];,\s]*$/;
/** 签名行上限:块很长时取前若干有效行已足够唯一定位。 */
const MAX_SIGNATURE_LINES = 8;

function signatureLines(blockContent: string): string[] {
	return blockContent
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !NOISE_LINE.test(line))
		.slice(0, MAX_SIGNATURE_LINES);
}

interface Candidate {
	file: string;
	/** 覆盖符号的 targetId;无覆盖符号时为 undefined(文件级)。 */
	targetId?: string;
	/** 命中的有效行数。 */
	hits: number;
}

/** 行集包含匹配:块的有效行(trim 相等)落在文件行集合内,统计每函数命中数。 */
function findCandidates(
	signature: string[],
	symbols: CppSymbol[],
	file: string,
	content: string
): Candidate[] {
	if (signature.length === 0) {
		return [];
	}
	const lines = content.split('\n').map((line) => line.trim());
	const lineIndex = new Map<string, number[]>();
	lines.forEach((line, index) => {
		const bucket = lineIndex.get(line);
		if (bucket) {
			bucket.push(index + 1);
		} else {
			lineIndex.set(line, [index + 1]);
		}
	});
	const candidates: Candidate[] = [];
	const fileSymbols = symbols.filter((symbol) => symbol.file === file);
	/** 行命中位置里存在非注释(有效代码)出现。 */
	const effectivePositions = (line: string): number[] =>
		(lineIndex.get(line) ?? []).filter((position) => {
			const raw = lines[position - 1] ?? '';
			return !raw.trim().startsWith('//');
		});
	for (const symbol of fileSymbols) {
		let hits = 0;
		for (const line of signature) {
			if (effectivePositions(line).some((position) =>
				position >= symbol.startLine && position <= symbol.endLine
			)) {
				hits++;
			}
		}
		// 多行块需要 ≥2 行有效命中(建议代码通常只有签名行同名);
		// 单行块交给顶层"全局唯一有效出现"闸补判,这里放行。
		if (hits >= 2 || signature.length === 1) {
			candidates.push({ file, targetId: symbol.targetId, hits });
		}
	}
	if (candidates.length > 0) {
		return candidates;
	}
	// 文件级归因收紧,两道闸:
	// 1) 签名首行在文件中必须是**非注释**的有效代码行(注释态函数的
	//    建议补全代码首行同名,不能靠注释行命中);
	// 2) 除首行外至少还有一行有效命中——模型建议的新代码通常只有
	//    函数头同名,体行不在文件里。单有效行块同样由顶层唯一性补判。
	const effectiveCount = signature.filter((line) =>
		effectivePositions(line).length > 0
	).length;
	if (effectiveCount >= 2 || (signature.length === 1 && effectiveCount === 1)) {
		candidates.push({ file, targetId: undefined, hits: effectiveCount });
	}
	return candidates;
}

/** 行内容在全部文件中的有效(非注释)出现次数。 */
function countEffectiveOccurrences(line: string, files: Map<string, string>): number {
	let count = 0;
	for (const content of files.values()) {
		for (const raw of content.split('\n')) {
			if (raw.trim() === line && !raw.trim().startsWith('//')) {
				count++;
			}
		}
	}
	return count;
}

export function detectCodeBlockSources(
	answer: string,
	symbols: CppSymbol[],
	files: Map<string, string>
): AnswerBlockSource[] {
	const blocks = [...answer.matchAll(FENCED_BLOCK_PATTERN)];
	const results: AnswerBlockSource[] = [];
	blocks.forEach((block, blockIndex) => {
		const signature = signatureLines(block[1]);
		if (signature.length === 0) {
			results.push({ blockIndex, status: 'none' });
			return;
		}
		const candidates: Candidate[] = [];
		for (const [file, content] of files) {
			candidates.push(...findCandidates(signature, symbols, file, content));
		}
		// 单行有效块的特殊闸:该行内容在**全部文件**中的有效(非注释)
		// 出现必须恰好一次。函数级/文件级多行闸在 findCandidates 里,
		// 单行命中只有全局唯一才可信(历史清洗要的是归属证据)。
		const singleLine = signature.length === 1;
		if (singleLine) {
			const occurrences = countEffectiveOccurrences(signature[0], files);
			if (occurrences !== 1) {
				results.push({
					blockIndex,
					status: occurrences === 0 ? 'none' : 'ambiguous',
				});
				return;
			}
		}
		if (candidates.length === 0) {
			results.push({ blockIndex, status: 'none' });
			return;
		}
		// 共享样板行(#pragma once、常见 include)会让多个文件都命中少量行:
		// 按命中数取最大者;并列且跨文件才 ambiguous(宁缺毋滥)。
		const byFile = new Map<string, number>();
		for (const candidate of candidates) {
			byFile.set(candidate.file, (byFile.get(candidate.file) ?? 0) + candidate.hits);
		}
		const ranked = [...byFile.entries()].sort((left, right) => right[1] - left[1]);
		if (ranked.length > 1 && ranked[0][1] === ranked[1][1]) {
			results.push({ blockIndex, status: 'ambiguous' });
			return;
		}
		const file = ranked[0][0];
		const symbolCandidates = candidates
			.filter((candidate) => candidate.file === file && candidate.targetId);
		if (symbolCandidates.length > 0) {
			// 类符号的范围包住方法(嵌套),命中行会同时命中两者:
			// 取行范围最小的(最内层)符号;并列最小才降级文件级。
			const fileSymbols = symbols.filter((symbol) => symbol.file === file);
			const innermost = symbolCandidates
				.map((candidate) => ({
					candidate,
					span: (() => {
						const symbol = fileSymbols.find(
							(item) => item.targetId === candidate.targetId
						);
						return symbol ? symbol.endLine - symbol.startLine : Number.MAX_SAFE_INTEGER;
					})(),
				}))
				.sort((left, right) => left.span - right.span);
			if (innermost.length === 1 || innermost[0].span < innermost[1].span) {
				results.push({
					blockIndex,
					status: 'unique',
					file,
					targetId: innermost[0].candidate.targetId!,
				});
				return;
			}
		}
		results.push({ blockIndex, status: 'unique-file', file });
	});
	return results;
}
