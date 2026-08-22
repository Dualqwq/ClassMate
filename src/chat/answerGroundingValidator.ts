import type { CppSymbol } from '../parser/cppWorkspaceIndex';

/**
 * 7.7 回答事实接地校验(纯函数):模型回答中关于当前工作区代码结构事实的
 * 声明(注释态/空体/计数/完成性/存在性),交付前用 Tree-sitter body 事实确定性核对。
 *
 * 设计边界(与旧 bug1-regex 的本质区别):
 * - 中文/数字模式只负责**定位候选声明句**并绑定符号;真伪判定全部依据
 *   CppBodyFacts,不再用正则猜模型意思;
 * - 声明绑定不到唯一符号 → 跳过(宁缺毋滥,漏检无副作用);同名多符号
 *   按限定容器/句内文件/行号范围消歧,仍不唯一则放弃;
 * - 不可核对的措辞不产生冲突;只有"声明 vs 事实"明确矛盾才判 conflict。
 * - 对比句型(如 "A已实现但B未实现")按句法就近/主语归属绑定状态,
 *   不得把转折前后的状态张冠李戴。
 */
export type GroundingClaimKind = 'comment_only' | 'empty' | 'count' | 'completion' | 'existence';

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

/**
 * 句内符号绑定(2026-08-21 run17 审阅升级:裸名 + 消歧)。
 * 行内代码(含带参/限定形态)与裸标识符都参与;同名多符号时按
 * 限定容器 → 句内文件提及 → 行号范围重叠 逐级消歧,仍不唯一则放弃
 * (宁缺毋滥)。只有函数类符号参与:类/字段没有可核对的函数体事实,
 * 绑定它们只会产生误伤(例:"X 和 `Monster` 都重写了它"不应把空体
 * 声明安到类符号头上)。
 */
const CLAIMABLE_KINDS = new Set<CppSymbol['kind']>([
	'function', 'method', 'constructor', 'destructor', 'operator',
]);

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface NameCandidate {
	name: string;
	/** 限定名形态(`Player::startTurn`)给出的容器名。 */
	container?: string;
}

/** 句内文件提及(x.h / x.cpp)。 */
function fileMentionsOf(sentence: string): string[] {
	return [...sentence.matchAll(/\b([A-Za-z_]\w*\.(?:h|hpp|cpp|c|cc|cxx))\b/g)]
		.map((match) => match[1]);
}

/** 句内行号范围提及(第 X 行 / 第 X-Y 行)。 */
function lineRangesOf(sentence: string): Array<[number, number]> {
	return [...sentence.matchAll(/第\s*(\d+)\s*(?:[-–—~至]\s*(\d+))?\s*行/g)]
		.map((match) => [Number(match[1]), Number(match[2] ?? match[1])] as [number, number]);
}

/** 转折/对比连词:左右分句的状态应各自绑定到本句主语。 */
const CONTRASTIVE_CONJUNCTIONS = /(?<!不|非)但(?:是)?|(?<!因)而(?!且)|然而|不过|却|可是|只(?:是|不过)|反而|相反|尽管如此/;

function hasMixedPolarity(text: string): boolean {
	const positive = CLAIM_PATTERNS.some(
		({ kind, pattern }) => kind === 'completion' && pattern.test(text)
	);
	const negative = CLAIM_PATTERNS.some(
		({ kind, pattern }) =>
			(kind === 'existence' || kind === 'empty' || kind === 'comment_only') &&
			pattern.test(text)
	);
	return positive && negative;
}

/**
 * 把句子切分为状态绑定单元。
 * - 显式转折(但/然而/不过等)按连词拆分;
 * - 无显式转折但含正负状态混合时,按逗号/分号拆分,避免
 *   "A已实现,B未实现"把两个状态都绑到两个符号上。
 */
function splitSentenceSegments(sentence: string): string[] {
	const byContrast = sentence
		.split(CONTRASTIVE_CONJUNCTIONS)
		.map((s) => s.trim())
		.filter(Boolean);
	if (byContrast.length === 1 && hasMixedPolarity(sentence)) {
		return sentence
			.split(/[，,；;]/)
			.map((s) => s.trim())
			.filter(Boolean);
	}
	return byContrast.length === 1
		? byContrast
		: byContrast.flatMap((segment) => splitSentenceSegments(segment));
}

/** 返回符号首次出现的分句索引;找不到时归于第 0 分句(兜底)。 */
function symbolSegmentIndex(symbol: CppSymbol, segments: string[]): number {
	for (let i = 0; i < segments.length; i++) {
		if (new RegExp(`\\b${escapeRegExp(symbol.name)}\\b`).test(segments[i])) {
			return i;
		}
	}
	return 0;
}

function locateSymbols(sentence: string, symbols: CppSymbol[]): CppSymbol[] {
	const candidates = new Map<string, NameCandidate>();
	for (const match of sentence.matchAll(
		/`([A-Za-z_]\w*(?:::[A-Za-z_]\w*)*)(?:\s*\([^`]*\))?`/g
	)) {
		const parts = match[1].split('::');
		const name = parts.pop()!;
		const container = parts.length > 0 ? parts[parts.length - 1] : undefined;
		const existing = candidates.get(name);
		if (!existing || (container && !existing.container)) {
			candidates.set(name, { name, container });
		}
	}
	// 裸标识符:仅当与真实符号名全词匹配时参与(claim 模式仍然把关,
	// 因此普通行文里的偶现不会产生声明)。
	for (const symbol of symbols) {
		if (!CLAIMABLE_KINDS.has(symbol.kind) || candidates.has(symbol.name)) {
			continue;
		}
		if (new RegExp(`\\b${escapeRegExp(symbol.name)}\\b`).test(sentence)) {
			candidates.set(symbol.name, { name: symbol.name });
		}
	}
	const files = fileMentionsOf(sentence);
	const ranges = lineRangesOf(sentence);
	const resolved: CppSymbol[] = [];
	for (const { name, container } of candidates.values()) {
		let matches = symbols.filter(
			(symbol) => CLAIMABLE_KINDS.has(symbol.kind) && symbol.name === name
		);
		if (matches.length > 1 && container) {
			const byContainer = matches.filter((symbol) => symbol.container === container);
			if (byContainer.length === 1) {
				matches = byContainer;
			}
		}
		if (matches.length > 1 && files.length > 0) {
			const byFile = matches.filter((symbol) => files.includes(symbol.file));
			if (byFile.length === 1) {
				matches = byFile;
			}
		}
		if (matches.length > 1 && ranges.length === 1) {
			const [from, to] = ranges[0];
			const byRange = matches.filter(
				(symbol) => symbol.startLine <= to && symbol.endLine >= from
			);
			if (byRange.length === 1) {
				matches = byRange;
			}
		}
		if (matches.length === 1) {
			resolved.push(matches[0]);
		}
	}
	return resolved;
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
		pattern: /已经(写|补|改|实现)(完|好)了?|不需要再(改|动|写)|(可以|不用)再改了|算是完成了|(✅\s*)?(?<![未没])已(实现|写好|写完|完成|改好)|(已|都)?改好了/,
	},
	{
		// 存在性声明(run17 取证:done-38 与 mut-comments-to-empty T2 两例
		// "还没实现/需要补全"指向已有实现的函数,残留 TODO 注释误导所致)。
		// 只收补全类动词(补全/补上/补完):"要实现两件事"这类描述句
		// 不算存在性断言。
		kind: 'existence',
		statedFact: 'empty',
		pattern: /(?:还)?没(?:有)?(?:实现|写好|写完|完成)|尚未(?:实现|写好|写完|完成)|未实现|待实现|待补全|需要(?:你)?(?:动手|去)?(?:补全|补上|补完)|要(?:你)?(?:去)?(?:补全|补上|补完)/,
	},
];

/** 否定/疑问措辞:不构成对当前状态的断言。 */
const NEGATION_GUARD = /(不是|并非|不再?是|没有说|难道|吗[?？]$|是不?是|是否)/;

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
		// 一句可谈论多个符号(枚举型回答的常态),逐个绑定核对。
		// 对比句型先按转折/标点切分,状态只绑到同一句法分句的符号,
		// 避免 "A已实现但B未实现" 把两种状态交叉绑到两个符号。
		const resolvedSymbols = locateSymbols(sentence, symbols);
		if (resolvedSymbols.length === 0) {
			continue;
		}
		const segments = splitSentenceSegments(sentence);
		for (const symbol of resolvedSymbols) {
			const actual = factOf(symbol);
			const symbolSegment = symbolSegmentIndex(symbol, segments);
			const bindingScope = segments[symbolSegment];
			for (const { kind, statedFact, pattern } of CLAIM_PATTERNS) {
				if (!pattern.test(bindingScope)) {
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
				// 注释态/空体/存在性(负向)声明与"实际有代码"矛盾;
				// 完成性声明与"空/注释"矛盾。
				const contradicts = kind === 'comment_only' || kind === 'empty' || kind === 'existence'
					? actual === 'active'
					: kind === 'completion'
						? actual === 'empty' || actual === 'comment_only'
						: false;
				if (contradicts) {
					conflicts.push(claim);
				}
			}
			const count = countClaimOf(bindingScope);
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
	}
	return { claims, conflicts, passed: conflicts.length === 0 };
}

const FACT_TEXT: Record<GroundingFact, string> = {
	active: '已有实际代码',
	empty: '函数体为空',
	comment_only: '只有注释,没有实际代码',
	done: '已完成',
};

/**
 * 符号当前状态的事实句(依据 Tree-sitter 行范围与函数体事实)。
 * 7.8 恢复兜底与 7.7 冲突提示共用同一事实口径。
 */
export function symbolStateSentence(symbol: CppSymbol): string {
	const location = `（${symbol.file} 第 ${symbol.startLine}–${symbol.endLine} 行）`;
	const body = symbol.body;
	if (!body) {
		return `\`${symbol.name}\`${location}当前定义在文件中`;
	}
	if (body.empty) {
		return `\`${symbol.name}\`${location}当前函数体为空`;
	}
	if (body.commentOnly) {
		return `\`${symbol.name}\`${location}当前只有注释,没有实际代码`;
	}
	return `\`${symbol.name}\`${location}当前已有实际代码,非空语句 ${body.nonEmptyStatementCount} 句`;
}

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
