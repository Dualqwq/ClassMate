import { COURSEWARE_GLOSSARY, COURSEWARE_TERM_ALIASES } from './glossary';

/**
 * 统一分词器（设计文档 §5.1）：
 * 1) 课程术语表最长匹配叠加在 Intl.Segmenter('zh', word) 基线之上——
 *    通用词典不识「二叉树」「最小生成树」等领域复合词，由术语表重组；
 * 2) 子串抑制：删去仍为其他保留词子串的碎片（如「生成树」⊂「最小生成树」）；
 * 3) chunk keywords = 分词结果按 标题×3 / 正文×1 加权取 top-N，
 *    取代旧的频窗 n-gram 伪词（D5）。
 *
 * VS Code 扩展宿主自带 full-icu Node（engines.vscode ^1.125），Intl.Segmenter 可用。
 */

export const MAX_KEYWORDS_PER_CHUNK = 12;

/** 高频虚字与提问用词：作为关键词只制造噪声匹配（查询侧停用于期 2 复用本模块）。 */
const STOP_WORDS = new Set([
	'的', '了', '是', '在', '和', '与', '或', '等', '对', '为', '有', '被', '将', '从', '到', '可以',
	'怎么', '怎样', '如何', '什么', '为什么', '哪个', '哪些', '哪里',
	'这个', '那个', '我们', '你们', '他们', '一个', '一些', '以及', '还有',
	'但是', '如果', '因为', '所以', '就是', '不是', '其中', '进行', '通过', '使用',
	'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'to', 'of', 'and', 'in',
	'on', 'at', 'by', 'for', 'with', 'about', 'as', 'into', 'through', 'this', 'that', 'these', 'those',
]);

interface GlossarySpan {
	start: number;
	end: number;
}

// 按首字符索引 + 组内长度降序，让最长匹配只需检查少量候选。
const glossaryByFirstChar = new Map<string, string[]>();
for (const term of COURSEWARE_GLOSSARY) {
	const key = term[0];
	const list = glossaryByFirstChar.get(key);
	if (list) {
		list.push(term);
	} else {
		glossaryByFirstChar.set(key, [term]);
	}
}
for (const list of glossaryByFirstChar.values()) {
	list.sort((a, b) => b.length - a.length);
}

const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });

/**
 * 对一段文本分词：术语表最长匹配优先，剩余片段交给 Intl.Segmenter。
 * 返回归一化后的词序列（含重复，保持出现顺序）；空文本返回空数组。
 */
export function tokenize(text: string): string[] {
	const tokens: string[] = [];
	let cursor = 0;
	for (const span of matchGlossarySpans(text)) {
		collectSegmentedTokens(text.slice(cursor, span.start), tokens);
		const normalized = normalizeToken(text.slice(span.start, span.end));
		if (normalized) {
			tokens.push(normalized);
		}
		cursor = span.end;
	}
	collectSegmentedTokens(text.slice(cursor), tokens);
	return tokens;
}

/**
 * 加权关键词提取：标题词 ×3、正文词 ×1，子串抑制后取 top-N。
 */
export function extractWeightedKeywords(title: string | undefined, body: string, limit = MAX_KEYWORDS_PER_CHUNK): string[] {
	const counters = new Map<string, number>();
	const add = (token: string, weight: number): void => {
		counters.set(token, (counters.get(token) ?? 0) + weight);
	};
	for (const token of tokenize(title ?? '')) {
		add(token, 3);
	}
	for (const token of tokenize(body)) {
		add(token, 1);
	}

	// 子串抑制：保留最大覆盖词。碎片权重随词条一并丢弃。
	const tokens = [...counters.keys()];
	const suppressed = new Set(
		tokens.filter((token) => tokens.some((other) => other !== token && other.includes(token)))
	);

	return [...counters.entries()]
		.filter(([token]) => !suppressed.has(token))
		.sort((a, b) => b[1] - a[1] || tokens.indexOf(a[0]) - tokens.indexOf(b[0]))
		.slice(0, limit)
		.map(([token]) => token);
}

/**
 * 查询侧词条抽取（期 2 检索层 D7）：与索引侧共用同一分词器，
 * 废除旧的 2–6 字 n-gram 爆炸；命中别名组的中英术语扩展为全组成员
 * （英文提问可命中中文课件、反之亦然）。返回去重后的查询词集。
 */
export function extractQueryTerms(query: string): string[] {
	const base = new Set(tokenize(query));
	const expanded = new Set(base);
	for (const token of base) {
		for (const group of COURSEWARE_TERM_ALIASES) {
			if (group.includes(token)) {
				for (const alias of group) {
					expanded.add(alias);
				}
			}
		}
	}
	return [...expanded];
}

function matchGlossarySpans(text: string): GlossarySpan[] {
	const spans: GlossarySpan[] = [];
	let i = 0;
	while (i < text.length) {
		const candidates = glossaryByFirstChar.get(text[i].toLowerCase());
		let matched = false;
		if (candidates) {
			for (const term of candidates) {
				if (text.slice(i, i + term.length).toLowerCase() === term) {
					spans.push({ start: i, end: i + term.length });
					i += term.length;
					matched = true;
					break;
				}
			}
		}
		if (!matched) {
			i++;
		}
	}
	return spans;
}

function collectSegmentedTokens(text: string, out: string[]): void {
	if (!text.trim()) {
		return;
	}
	for (const { segment, isWordLike } of segmenter.segment(text)) {
		if (!isWordLike) {
			continue;
		}
		const normalized = normalizeToken(segment);
		if (normalized) {
			out.push(normalized);
		}
	}
}

function normalizeToken(segment: string): string {
	const token = segment.trim().toLowerCase();
	if (!token || STOP_WORDS.has(token)) {
		return '';
	}
	if (/^\d+$/.test(token)) {
		return ''; // 纯数字年份/页号等不作为检索词
	}
	// 英文/数字混合词至少 2 字符；单字 CJK 是真词（树/图/环），保留。
	if (!/[\u4e00-\u9fa5]/.test(token) && token.length < 2) {
		return '';
	}
	return token;
}
