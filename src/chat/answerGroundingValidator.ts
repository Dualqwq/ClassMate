import type { CppSymbol } from '../parser/cppWorkspaceIndex';

/**
 * 7.7 回答事实接地校验(纯函数):模型回答中关于当前工作区代码结构事实的
 * 声明(注释态/空体/计数/完成性),交付前用 Tree-sitter body 事实确定性核对。
 *
 * 设计边界(与旧 bug1-regex 的本质区别):
 * - 中文/数字模式只负责**定位候选声明句**并绑定符号;真伪判定全部依据
 *   CppBodyFacts,不再用正则猜模型意思;
 * - 声明绑定不到唯一符号 → 跳过(宁缺毋滥,漏检无副作用);
 * - 不可核对的措辞不产生冲突;只有"声明 vs 事实"明确矛盾才判 conflict。
 */
export type GroundingClaimKind = 'comment_only' | 'empty' | 'count' | 'completion';

export type GroundingFact = 'active' | 'empty' | 'comment_only' | 'done';

export interface GroundingClaim {
	kind: GroundingClaimKind;
	/** 声明谈论的符号(唯一绑定);无法定位则不产生 claim。 */
	targetId: string;
	symbolName: string;
	/** 声明主张的事实。 */
	statedFact: GroundingFact;
	/** 冻结工作区的实际事实。 */
	actualFact: GroundingFact;
	/** 声明所在句子(诊断用)。 */
	sentence: string;
	/** 计数声明的主张数值(其余类别 undefined)。 */
	statedCount?: number;
}

export interface GroundingConflict extends GroundingClaim {
}

export interface GroundingCheckResult {
	claims: GroundingClaim[];
	conflicts: GroundingConflict[];
	passed: boolean;
}

function factOf(symbol: CppSymbol): GroundingFact {
	const body = symbol.body;
	if (!body) {
		return 'active'; // 无解析事实时不与"空/注释"类声明对抗,按有内容处理
	}
	if (body.commentOnly) {
		return 'comment_only';
	}
	if (body.empty) {
		return 'empty';
	}
	return 'active';
}

/** 句内行内代码 `` `name` `` → 唯一同名符号;多目标/无命中返回 undefined。 */
function locateSymbol(sentence: string, symbols: CppSymbol[]): CppSymbol | undefined {
	const names = [...sentence.matchAll(/`([A-Za-z_]\w*(?:::[A-Za-z_]\w*)*)`/g)]
		.map((match) => match[1].split('::').pop()!);
	const unique = new Set<string>();
	const byName = new Map<string, CppSymbol>();
	for (const symbol of symbols) {
		if (!names.includes(symbol.name)) {
			continue;
		}
		if (byName.has(symbol.name)) {
			unique.delete(symbol.name);
			continue;
		}
		byName.set(symbol.name, symbol);
		unique.add(symbol.name);
	}
	if (unique.size !== 1) {
		return undefined;
	}
	return byName.get([...unique][0]);
}

interface ClaimPattern {
	kind: GroundingClaimKind;
	statedFact: GroundingFact;
	pattern: RegExp;
}

/** 声明定位模式:只认"断言当前代码状态"的形态;疑问/否定由前置过滤器排除。 */
const CLAIM_PATTERNS: ClaimPattern[] = [
	{
		kind: 'comment_only',
		statedFact: 'comment_only',
		pattern: /(只有|都是|全是|只剩下?)(被)?(注释掉?了?)?(的)?(注释|代码)|(被)?注释掉?了|只剩(下)?注释|处于注释(状态)?|注释状态|没(有)?真正?取消注释/,
	},
	{
		kind: 'empty',
		statedFact: 'empty',
		pattern: /(函数体?|body)?(是)?空的|什么都没(有)?(做|写|实现)|没有(实际|有效)?(代码|内容|语句)/,
	},
	{
		kind: 'completion',
		statedFact: 'done',
		pattern: /已经(写|补|改|实现)(完|好)了?|不需要再(改|动|写)|(可以|不用)再改了|算是完成了/,
	},
];

/** 否定/疑问措辞:不构成对当前状态的断言。 */
const NEGATION_GUARD = /(不是|并非|不再?是|没有说|难道|吗[?？]$|是不?是)/;

function countClaimOf(sentence: string): { statedCount: number } | undefined {
	const match = /(?:有|只有|一共|共|就|只剩)\s*(\d+)\s*(?:行|条|句)/.exec(sentence)
		?? /(?:只剩|就)?一(?:行|条|句)(?:实际)?(?:代码|内容)?/.exec(sentence);
	if (!match) {
		return undefined;
	}
	const digit = /(\d+)/.exec(match[0]);
	return { statedCount: digit ? Number(digit[1]) : 1 };
}

function actualCountOf(symbol: CppSymbol): number | undefined {
	return symbol.body?.nonEmptyStatementCount;
}

export function checkAnswerGrounding(
	answer: string,
	symbols: CppSymbol[]
): GroundingCheckResult {	const claims: GroundingClaim[] = [];
	const conflicts: GroundingConflict[] = [];
	if (symbols.length === 0) {
		return { claims, conflicts, passed: true };
	}
	const sentences = answer
		.split(/(?<=[。！？!?\n])/)
		.map((sentence) => sentence.trim())
		.filter(Boolean);
	for (const sentence of sentences) {
		if (NEGATION_GUARD.test(sentence)) {
			continue;
		}
		const symbol = locateSymbol(sentence, symbols);
		if (!symbol) {
			continue;
		}
		const actual = factOf(symbol);
		for (const { kind, statedFact, pattern } of CLAIM_PATTERNS) {
			if (!pattern.test(sentence)) {
				continue;
			}
			const claim: GroundingClaim = {
				kind,
				targetId: symbol.targetId,
				symbolName: symbol.name,
				statedFact,
				actualFact: actual,
				sentence,
			};
			claims.push(claim);
			const contradicts = kind === 'comment_only'
				? actual === 'active'
				: kind === 'empty'
					? actual === 'active'
					: kind === 'completion'
						? actual === 'empty' || actual === 'comment_only'
						: false;
			if (contradicts) {
				conflicts.push(claim);
			}
		}
		const count = countClaimOf(sentence);
		if (count) {
			const actualCount = actualCountOf(symbol);
			if (actualCount !== undefined) {
				const claim: GroundingClaim = {
					kind: 'count',
					targetId: symbol.targetId,
					symbolName: symbol.name,
					statedFact: 'active',
					actualFact: actual,
					sentence,
					statedCount: count.statedCount,
				};
				claims.push(claim);
				// 计数冲突:符号是空/注释态却称有 N 行,或数量对不上(允差 0)。
				if ((actual === 'empty' || actual === 'comment_only')
					|| count.statedCount !== actualCount) {
					conflicts.push(claim);
				}
			}
		}
	}
	return { claims, conflicts, passed: conflicts.length === 0 };
}

const FACT_TEXT: Record<GroundingFact, string> = {
	active: '已有实际代码',
	empty: '函数体为空',
	comment_only: '只有注释,没有实际代码',
	done: '已完成',
};

/** 单条冲突的事实句:目标符号 + 实际状态(依据 Tree-sitter 行范围)。 */
function conflictFactSentence(
	claim: GroundingClaim,
	symbols: CppSymbol[]
): string {
	const symbol = symbols.find((item) => item.targetId === claim.targetId);
	const location = symbol
		? `（${symbol.file} 第 ${symbol.startLine}–${symbol.endLine} 行）`
		: '';
	const countText = symbol?.body
		? `，非空语句 ${symbol.body.nonEmptyStatementCount} 句`
		: '';
	return `\`${claim.symbolName}\`${location}当前${claim.actualFact === 'active' ? `已有实际代码${countText}` : FACT_TEXT[claim.actualFact]}`;
}

/**
 * 重生成指令:把本地事实作为硬约束注入,要求模型以此为准重写,
 * 不出现内部术语(与教学更正文案规范一致)。
 */
export function buildGroundingRetryInstruction(
	conflicts: GroundingConflict[],
	symbols: CppSymbol[]
): string {
	const seenTargets = new Set<string>();
	const facts = conflicts
		.filter((claim) => {
			if (seenTargets.has(claim.targetId)) {
				return false;
			}
			seenTargets.add(claim.targetId);
			return true;
		})
		.map((claim) => conflictFactSentence(claim, symbols))
		.join('；');
	return [
		'=== 当前文件事实（以此为准，覆盖你此前的一切印象）===',
		facts + '。',
		'你上一版回答中关于上述代码状态的描述与当前文件不符。请基于这些事实重新组织回答：',
		'- 不要复述与上述事实矛盾的状态描述（例如与实际相反的“是空的/只有注释/已经写完”）。',
		'- 引导学生核对当前文件内容，再继续教学。',
	].join('\n');
}

/**
 * 本地事实提示:重生成仍冲突或无法重生成时的最终兜底。
 * 由程序事实确定性生成,含道歉措辞,不出现内部术语。
 * 同一符号的多条冲突只陈述一次事实。
 */
export function buildGroundedLocalHint(
	conflicts: GroundingConflict[],
	symbols: CppSymbol[]
): string {
	const seenTargets = new Set<string>();
	const facts = conflicts
		.filter((claim) => {
			if (seenTargets.has(claim.targetId)) {
				return false;
			}
			seenTargets.add(claim.targetId);
			return true;
		})
		.map((claim) => conflictFactSentence(claim, symbols))
		.join('；');
	return [
		'抱歉，我刚才对代码状态的描述与当前文件不符，先给你当前文件的准确状态：',
		facts + '。',
		'你可以直接打开对应文件核对这个范围；如果你刚才确实做了修改，也可以把改动告诉我，我们从这个状态继续。',
	].join('\n');
}
