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
 * - 预算纪律:整块默认 ≤10000 字符(2026-08-29 拍板由 2000 放宽,全局统一
 *   不分复习/普通回答场景),超出按「当前文件 > 同题目 > 其余最近」
 *   截断;无内容时返回 '',由 prompt 构造端保证完全不注入占位块;
 * - 新鲜度标注:每条条目按本地自然日差标注相对时间(口径见 formatRelativeAge:
 *   今天 HH:mm / 昨天 HH:mm / N 天前 / M月D日),免责句尾部追加最早/最新条目
 *   的时间跨度提示,让「整体有多旧」一眼可见;`nowMs` 可注入,同输入逐字节
 *   同输出。**刻意不做硬性时间窗(不按新旧删事件)**:错题复盘的使命就是回顾
 *   旧错题,硬窗会静默丢弃它们;标注只呈现年龄,由模型与学生自行权衡新旧;
 * - 只进模型上下文,不改 ChatState、不进会话存储、不产生 UI 消息。
 */

/** 整块字符预算(含标题与免责声明行)。2026-08-29 拍板 2000 → 10000(全局统一)。 */
export const JOURNEY_DIGEST_MAX_CHARS = 10000;

/** 各节在预算截断前的事件条数上限(与整块预算同比例 5 → 25,兜底防单节独大)。 */
const MAX_COMPILE_ERROR_LINES = 25;
const MAX_RUN_ERROR_LINES = 25;
const MAX_MISTAKE_PATTERN_LINES = 25;

export interface JourneyDigestOptions {
    /** 当前打开文件的路径(file:// URI 或普通路径);用于相关度排序。 */
    currentFilePath?: string;
    /** 字符预算上限,默认 JOURNEY_DIGEST_MAX_CHARS。 */
    maxChars?: number;
    /**
     * 当前时刻(epoch ms),相对时间标注与免责句的时间跨度提示以此计算;
     * 缺省 Date.now()。纯函数口径:测试注入固定值,同 events + 同 nowMs
     * 输出逐字节相同。
     */
    nowMs?: number;
}

const DIGEST_HEADER = '=== Student debugging history digest ===';

/**
 * 历史定位声明(固定部分):明确这是历史调试记录摘要,模型可主动引用但不得虚构,
 * 且一切以当前加载的文件为准。措辞不含内部术语,单测有断言。
 */
const DIGEST_DISCLAIMER_CORE = [
    'The notes below summarize this student\u2019s recent compile and run history recorded in this workspace.',
    'The history may be outdated or already fixed.',
    'You may proactively reference these records when they help your answer, but never invent details that are not listed here, and verify every claim against the currently loaded files.',
].join(' ');

/**
 * 相对时间标注口径(新鲜度标注,#13 复盘场景):按本地时区**自然日差**分桶
 * (不是 24 小时整倍数,跨月/跨年只看天数差),格式与条目行的中文标注协调:
 * - 同一自然日(未来时间戳一并兜底按今天处理) → 「今天 HH:mm」;
 * - 上一个自然日 → 「昨天 HH:mm」;
 * - 距今 2–6 个自然日 → 「N 天前」;
 * - 距今 ≥7 个自然日 → 绝对日期「M月D日」。
 * 纯函数:同 (timestampMs, nowMs) 输出恒定;DST 造成的当日时长漂移由
 * Math.round 吸收。测试注入固定 nowMs,不得依赖真实时钟。
 */
export function formatRelativeAge(timestampMs: number, nowMs: number): string {
    const DAY_MS = 86_400_000;
    const dayStart = (ms: number): number => {
        const d = new Date(ms);
        d.setHours(0, 0, 0, 0);
        return d.getTime();
    };
    const dayDiff = Math.round((dayStart(nowMs) - dayStart(timestampMs)) / DAY_MS);
    const at = new Date(timestampMs);
    const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
    if (dayDiff <= 0) {
        return `今天 ${hhmm}`;
    }
    if (dayDiff === 1) {
        return `昨天 ${hhmm}`;
    }
    if (dayDiff <= 6) {
        return `${dayDiff} 天前`;
    }
    return `${at.getMonth() + 1}月${at.getDate()}日`;
}

/**
 * 历史定位声明 + 新鲜度跨度提示:在固定声明后追加最早/最新条目距今多久,
 * 让「整体有多旧」一眼可见。跨度在节截断/预算截断**之前**按全部摘要候选条目
 * 计算——预算裁掉个别行后,该句仍真实描述这批未解决记录的时间范围。
 * 无候选条目时原样返回固定声明(此时整块会返回 '',不会真正注入)。
 */
function freshnessDisclaimer(
    oldestRecency: number | undefined,
    newestRecency: number | undefined,
    nowMs: number
): string {
    if (oldestRecency === undefined || newestRecency === undefined) {
        return DIGEST_DISCLAIMER_CORE;
    }
    return [
        DIGEST_DISCLAIMER_CORE,
        `Freshness: the oldest entry is from ${formatRelativeAge(oldestRecency, nowMs)}, and the newest entry is from ${formatRelativeAge(newestRecency, nowMs)}.`,
    ].join(' ');
}

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

function compileErrorItem(
    episode: ReturnType<typeof buildJourneyViewModel>['episodes'][number],
    nowMs: number
): DigestItem {
    const file = baseName(episode.fileUri);
    const location = file ? `${file}${episode.line ? `:${episode.line}` : ''}` : '(未知文件)';
    const label = conceptLabelForMessage(episode.message ?? '');
    return {
        sectionIndex: SECTION_COMPILE,
        // 新鲜度标注与 recency 同源(firstSeenAt):「显示的年龄」与「同级内
        // 排序」永远用同一个时间戳,标注计入条目文本、随贪心装填计入预算。
        text: `- ${location} ${label} [${severityLabel(episode.severity)}]（${formatRelativeAge(episode.firstSeenAt, nowMs)}）`,
        relevant: false,
        recency: episode.firstSeenAt,
    };
}

function runErrorItem(
    episode: ReturnType<typeof buildJourneyViewModel>['episodes'][number],
    nowMs: number
): DigestItem {
    // 独立 run_error episode 的 message 已是学生化文案(分类标签+退出码,
    // 见 journeyViewModel.describeRunOutcome);缺省时退回分类标签。
    const label = episode.message || (episode.runErrorKind
        ? RUN_ERROR_KIND_LABELS[episode.runErrorKind]
        : '运行出错');
    const file = baseName(episode.fileUri);
    return {
        sectionIndex: SECTION_RUN,
        text: `- ${label}${file ? ` [${file}]` : ''}（${formatRelativeAge(episode.firstSeenAt, nowMs)}）`,
        relevant: false,
        recency: episode.firstSeenAt,
    };
}

function mistakePatternItem(
    card: ReturnType<typeof buildJourneyViewModel>['mistakeCards'][number],
    nowMs: number
): DigestItem {
    const unresolvedSuffix = card.unresolvedCount > 0
        ? `(${card.unresolvedCount} 次未解决)`
        : '';
    return {
        sectionIndex: SECTION_PATTERN,
        // 错题卡聚合多次犯错,标注取 lastSeenAt(最近一次出现)与 recency 同源。
        text: `- ${card.title} ×${card.frequency}${unresolvedSuffix}（${formatRelativeAge(card.lastSeenAt, nowMs)}）`,
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
    const nowMs = options.nowMs ?? Date.now();
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
                compileErrorItem(episode, nowMs),
                episode.fileUri,
                episode.problemKey
            ));
        } else if (episode.runErrorKind !== undefined) {
            // run_error 独立 episode(FE3):fileUri 是 exe 路径,problemKey 已
            // 由视图模型归并到源文件同名题(main.cpp ↔ main.exe)。
            items.push(markRelevant(
                runErrorItem(episode, nowMs),
                episode.fileUri,
                episode.problemKey
            ));
        }
    }
    for (const card of view.mistakeCards) {
        items.push(markRelevant(mistakePatternItem(card, nowMs), card.fileUri, card.problemKey));
    }

    // 新鲜度跨度:按全部候选条目(节截断/预算截断之前)的最早/最新时间戳计算,
    // 拼进免责句(见 freshnessDisclaimer);items 为空时整块返回 '',跨度无意义。
    let oldestRecency: number | undefined;
    let newestRecency: number | undefined;
    for (const item of items) {
        oldestRecency = oldestRecency === undefined
            ? item.recency
            : Math.min(oldestRecency, item.recency);
        newestRecency = newestRecency === undefined
            ? item.recency
            : Math.max(newestRecency, item.recency);
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
    const headerBlock = `${DIGEST_HEADER}\n${freshnessDisclaimer(oldestRecency, newestRecency, nowMs)}`;
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

    const out: string[] = [DIGEST_HEADER, freshnessDisclaimer(oldestRecency, newestRecency, nowMs)];
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
