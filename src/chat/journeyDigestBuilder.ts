import { getKnowledgeConcept, matchErrorToKnowledge } from '../error/errorKnowledgeMap';
import type { DebugEvent } from '../debug/types';
import { buildJourneyViewModel, deriveProblemKey } from '../journey/journeyViewModel';
import { RUN_ERROR_KIND_LABELS } from '../run/runErrorKind';

/**
 * Debug Journey 历史摘要注入(#13,轨 FE2 重做版)。
 *
 * 把 DebugJourneyStore 里的编译/运行历史与错题模式做**确定性**摘要,产出一段
 * 紧凑文本块注入 answer prompt 的 system 区。设计要点(docs/journey-digest-design.md):
 * - 纯函数、无副作用:输入事件数组,输出字符串,可单测;
 * - 复用 FE1/FE3 的派生口径(buildJourneyViewModel 的折叠、解决判定与
 *   deriveProblemKey 题目归并),不另造一套生命周期推导;
 * - 预算纪律:整块默认 ≤2000 字符,超出按「当前文件 > 同题目 > 其余最近」
 *   截断;无内容时返回 '',由 prompt 构造端保证完全不注入占位块;
 * - 只进模型上下文,不改 ChatState、不进会话存储、不产生 UI 消息。
 */

/** 整块字符预算(含标题与免责声明行)。 */
export const JOURNEY_DIGEST_MAX_CHARS = 2000;

/** 各节在预算截断前的事件条数上限(预算通常先触顶,这里是兜底防单节独大)。 */
const MAX_COMPILE_ERROR_LINES = 5;
const MAX_RUN_ERROR_LINES = 5;
const MAX_MISTAKE_PATTERN_LINES = 5;

export interface JourneyDigestOptions {
    /** 当前打开文件的路径(file:// URI 或普通路径);用于相关度排序。 */
    currentFilePath?: string;
    /** 字符预算上限,默认 JOURNEY_DIGEST_MAX_CHARS。 */
    maxChars?: number;
}

const DIGEST_HEADER = '=== Student debugging history digest ===';

/**
 * 历史定位声明:明确这是历史调试记录摘要,模型可主动引用但不得虚构,
 * 且一切以当前加载的文件为准。措辞不含内部术语,单测有断言。
 */
const DIGEST_DISCLAIMER = [
    'The notes below summarize this student\u2019s recent compile and run history recorded in this workspace.',
    'The history may be outdated or already fixed.',
    'You may proactively reference these records when they help your answer, but never invent details that are not listed here, and verify every claim against the currently loaded files.',
].join(' ');

const SECTION_HEADERS = [
    'Unresolved compile errors:',
    'Unresolved run errors:',
    'Recurring mistake patterns:',
] as const;

const SECTION_COMPILE = 0;
const SECTION_RUN = 1;
const SECTION_PATTERN = 2;

interface DigestItem {
    sectionIndex: number;
    text: string;
    /** 与当前打开文件同题(problemKey 相同)时为 true,截断时优先保留。 */
    relevant: boolean;
    /** 新近度(时间戳),同级内倒序保留。 */
    recency: number;
}

function baseName(uri: string | undefined): string | undefined {
    if (!uri) {
        return undefined;
    }
    return uri.split(/[\\/]/).pop();
}

function severityLabel(severity: string | undefined): string {
    return severity === 'warning' ? '编译警告' : '编译错误';
}

/**
 * 编译错误的可读概念标签:优先走 errorKnowledgeMap 的概念标题(如「变量/
 * 函数未声明」);不命中任何 pattern 时退回截断后的原始 message。
 */
function conceptLabelForMessage(message: string): string {
    const matched = matchErrorToKnowledge(message)
        .find((m) => getKnowledgeConcept(m.tag) !== undefined);
    if (matched) {
        return getKnowledgeConcept(matched.tag)!.title;
    }
    const compact = message.replace(/\s+/g, ' ').trim();
    return compact.length <= 80 ? compact : `${compact.slice(0, 80)}…`;
}

function compileErrorItem(episode: ReturnType<typeof buildJourneyViewModel>['episodes'][number]): DigestItem {
    const file = baseName(episode.fileUri);
    const location = file ? `${file}${episode.line ? `:${episode.line}` : ''}` : '(未知文件)';
    const label = conceptLabelForMessage(episode.message ?? '');
    return {
        sectionIndex: SECTION_COMPILE,
        text: `- ${location} ${label} [${severityLabel(episode.severity)}]`,
        relevant: false,
        recency: episode.firstSeenAt,
    };
}

function runErrorItem(episode: ReturnType<typeof buildJourneyViewModel>['episodes'][number]): DigestItem {
    // 独立 run_error episode 的 message 已是学生化文案(分类标签+退出码,
    // 见 journeyViewModel.describeRunOutcome);缺省时退回分类标签。
    const label = episode.message || (episode.runErrorKind
        ? RUN_ERROR_KIND_LABELS[episode.runErrorKind]
        : '运行出错');
    const file = baseName(episode.fileUri);
    return {
        sectionIndex: SECTION_RUN,
        text: `- ${label}${file ? ` [${file}]` : ''}`,
        relevant: false,
        recency: episode.firstSeenAt,
    };
}

function mistakePatternItem(card: ReturnType<typeof buildJourneyViewModel>['mistakeCards'][number]): DigestItem {
    const unresolvedSuffix = card.unresolvedCount > 0
        ? `(${card.unresolvedCount} 次未解决)`
        : '';
    return {
        sectionIndex: SECTION_PATTERN,
        text: `- ${card.title} ×${card.frequency}${unresolvedSuffix}`,
        relevant: false,
        recency: card.lastSeenAt,
    };
}

function bySectionThenRecency(a: DigestItem, b: DigestItem): number {
    if (a.sectionIndex !== b.sectionIndex) {
        return a.sectionIndex - b.sectionIndex;
    }
    return b.recency - a.recency;
}

function sectionCap(sectionIndex: number): number {
    switch (sectionIndex) {
        case SECTION_COMPILE:
            return MAX_COMPILE_ERROR_LINES;
        case SECTION_RUN:
            return MAX_RUN_ERROR_LINES;
        default:
            return MAX_MISTAKE_PATTERN_LINES;
    }
}

/**
 * 事件数组 → 确定性历史摘要文本块。
 * 无未解决错误且无错题模式时返回 ''(调用端不得注入占位块)。
 */
export function buildJourneyDigest(
    events: DebugEvent[],
    options: JourneyDigestOptions = {}
): string {
    const maxChars = Math.max(0, options.maxChars ?? JOURNEY_DIGEST_MAX_CHARS);
    const view = buildJourneyViewModel(events);

    const currentKey = deriveProblemKey(options.currentFilePath);
    const markRelevant = <T extends { relevant: boolean }>(
        item: T,
        relatedUri: string | undefined,
        relatedProblemKey: string | undefined
    ): T => {
        const relevant =
            (currentKey !== undefined && relatedProblemKey === currentKey) ||
            (currentKey !== undefined && deriveProblemKey(relatedUri) === currentKey);
        return { ...item, relevant };
    };

    const items: DigestItem[] = [];
    for (const episode of view.episodes) {
        if (episode.resolved) {
            continue;
        }
        const isFirstEntryCompile = episode.entries[0]?.kind === 'compile_error';
        if (isFirstEntryCompile) {
            items.push(markRelevant(
                compileErrorItem(episode),
                episode.fileUri,
                episode.problemKey
            ));
        } else if (episode.runErrorKind !== undefined) {
            // run_error 独立 episode(FE3):fileUri 是 exe 路径,problemKey 已
            // 由视图模型归并到源文件同名题(main.cpp ↔ main.exe)。
            items.push(markRelevant(
                runErrorItem(episode),
                episode.fileUri,
                episode.problemKey
            ));
        }
    }
    for (const card of view.mistakeCards) {
        items.push(markRelevant(mistakePatternItem(card), card.fileUri, card.problemKey));
    }

    // 相关度优先:当前文件/同题在前,其余按新近度;节内顺序与每节条数上限兜底。
    const relevantSorted = items.filter((i) => i.relevant).sort(bySectionThenRecency);
    const restSorted = items.filter((i) => !i.relevant).sort(bySectionThenRecency);
    const capped: DigestItem[] = [];
    const perSectionCount = new Map<number, number>();
    for (const item of [...relevantSorted, ...restSorted]) {
        const count = perSectionCount.get(item.sectionIndex) ?? 0;
        if (count >= sectionCap(item.sectionIndex)) {
            continue;
        }
        perSectionCount.set(item.sectionIndex, count + 1);
        capped.push(item);
    }

    // 贪心装填:按相关度序逐条尝试,放不下先跳过(后面更短的条目仍可能进),
    // 保证预算内塞入尽可能多的高相关条目。节标题与空行也计入预算,
    // 否则最终整块会超出 maxChars 的承诺。
    const headerBlock = `${DIGEST_HEADER}\n${DIGEST_DISCLAIMER}`;
    let used = headerBlock.length;
    const accepted: DigestItem[] = [];
    const emittedSections = new Set<number>();
    for (const item of capped) {
        const sectionHeaderCost = emittedSections.has(item.sectionIndex)
            ? 0
            : SECTION_HEADERS[item.sectionIndex].length + 1;
        const cost = item.text.length + 1 + sectionHeaderCost;
        if (used + cost > maxChars) {
            continue;
        }
        used += cost;
        emittedSections.add(item.sectionIndex);
        accepted.push(item);
    }
    if (accepted.length === 0) {
        return '';
    }

    const out: string[] = [DIGEST_HEADER, DIGEST_DISCLAIMER];
    for (let sectionIndex = SECTION_COMPILE; sectionIndex <= SECTION_PATTERN; sectionIndex++) {
        const sectionItems = accepted.filter((i) => i.sectionIndex === sectionIndex);
        if (sectionItems.length === 0) {
            continue;
        }
        out.push(SECTION_HEADERS[sectionIndex]);
        for (const item of sectionItems) {
            out.push(item.text);
        }
    }
    return out.join('\n');
}
