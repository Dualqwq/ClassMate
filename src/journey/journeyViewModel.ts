import type { ParsedError } from '../error/errorParser';
import { computeDebugMetrics } from '../debug/analytics';
import { buildErrorLifecycles, type ErrorLifecycle } from '../debug/errorLifecycle';
import {
    generateKnowledgeCard,
    mergeAndSortKnowledgeCards,
    pickRepresentativeError,
    type ConcreteFix,
    type KnowledgeCard,
} from '../debug/knowledgeCard';
import {
    isCodeModified,
    isCompileError,
    isCompileSuccess,
    isHintRequested,
    isRunError,
    type DebugEvent,
} from '../debug/types';

/**
 * Journey 面板视图模型(#12a/#14a,轨 FE1)。
 *
 * 设计文档 docs/frontend-teaching-design.md §3.3:面板不直接读 store,由
 * extension host 取事件 → 跑派生纯函数 → 把「视图模型」经消息桥推给
 * webview;webview 只做渲染与交互回传,不在前端重算聚合。
 * 本文件就是那组派生纯函数:输入事件数组,输出时间线 episode、错题卡与
 * 学生化指标,全部可单测、不落盘、不改既有 debug 派生语义。
 */

/** 时间线单条目(设计稿 §4.1 卡片内的 ├ └ 行)。 */
export interface JourneyEntryVM {
    eventId: string;
    kind: 'compile_error' | 'compile_success' | 'code_modified' | 'hint_requested' | 'run_error';
    timestamp: number;
    /** 学生化摘要文案(不含内部术语),如「编译失败(2 个错误)」。 */
    label: string;
    /** code_modified 条目:本次编辑增删行数([看 diff] 用 journey:openDiff)。 */
    changedLines?: number;
}

/** 时间线一张 episode 卡 = 一个错误的完整生命周期。 */
export interface JourneyEpisodeVM {
    /** 起始 compile_error 事件 id;[在代码里看]/[求提示] 以此定位。 */
    errorEventId: string;
    /** 首条错误原文 message(现象行)。 */
    message: string;
    fileUri?: string;
    fileName?: string;
    line?: number;
    firstSeenAt: number;
    resolvedAt?: number;
    resolved: boolean;
    attemptsBeforeResolve: number;
    /** 生命周期内按时间升序的条目(起始编译失败必为第一条)。 */
    entries: JourneyEntryVM[];
}

/** 指标条数据(学生友好措辞在渲染层拼,这里只给数)。 */
export interface JourneyMetricsVM {
    totalEvents: number;
    resolvedErrors: number;
    unresolvedErrors: number;
    /** 已解决错误的平均修复尝试次数(编译次数口径)。 */
    avgFixAttempts: number;
    helpSeekingRatio: number;
    independentFixRatio: number;
}

/** 错题卡第三档的只读修复样例(学生自己写的 after)。 */
export interface MistakeFixVM extends ConcreteFix {}

/** 错题本一张卡(设计稿 §6.1):知识标签聚合 + 版本链徽章数据。 */
export interface MistakeCardVM {
    tag: string;
    title: string;
    /** 第一档默认可见:现象 = 代表性错误原文 message。 */
    phenomenon: string;
    commonCauses: string[];
    checkMethod: string;
    /** 第三档:自己的修复样例(去重后最多 3 条,既有常量)。 */
    fixes: MistakeFixVM[];
    /** 版本链:「第 N 次犯」= 该标签累计出现次数。 */
    frequency: number;
    resolvedCount: number;
    unresolvedCount: number;
    lastSeenAt: number;
    /** [在代码里看] 定位:代表性错误的位置。 */
    fileUri?: string;
    line?: number;
}

/** journey:sync 一次推送的整体视图模型(两个页签共用)。 */
export interface JourneyViewModel {
    generatedAt: number;
    metrics: JourneyMetricsVM;
    /** 未解决置顶在前,其余按首次出现倒序。 */
    episodes: JourneyEpisodeVM[];
    /** sortKnowledgeCards 序:未解决 > 频率 > 平均尝试 > 最近。 */
    mistakeCards: MistakeCardVM[];
}

const HINT_INTENT_LABELS: Record<string, string> = {
    chat: '提问',
    hint: '求提示',
    code_explanation: '问代码',
    concept_explanation: '问概念',
    error_explanation: '问报错',
    debug_suggestion: '问排查思路',
    summary: '要总结',
    code_edit: '请改代码',
};

function countDiagnosableErrors(parsedErrors: ParsedError[]): number {
    return parsedErrors.filter(
        (p) => p.severity === 'error' || p.severity === 'warning'
    ).length;
}

function countChangedLines(diff: string): number {
    return diff.split('\n').filter((line) => /^\+[^+]|^-[^-]/.test(line)).length;
}

function baseFileName(fileUri: string | undefined): string | undefined {
    if (!fileUri) {
        return undefined;
    }
    return fileUri.split(/[\\/]/).pop();
}

function buildEntriesForLifecycle(
    lifecycle: ErrorLifecycle,
    errorEvent: DebugEvent,
    sortedEvents: DebugEvent[]
): JourneyEntryVM[] {
    const entries: JourneyEntryVM[] = [];
    if (!isCompileError(errorEvent)) {
        return entries;
    }

    entries.push({
        eventId: errorEvent.id,
        kind: 'compile_error',
        timestamp: errorEvent.timestamp,
        label: `编译失败(${countDiagnosableErrors(errorEvent.parsedErrors)} 个错误)`,
    });

    const windowEnd = lifecycle.resolvedAt ?? Number.MAX_SAFE_INTEGER;
    for (const event of sortedEvents) {
        if (event.id === errorEvent.id) {
            continue;
        }
        if (event.timestamp <= errorEvent.timestamp || event.timestamp > windowEnd) {
            continue;
        }
        // 只串同一文件的修复过程;无文件信息的错误不设此限制。
        if (errorEvent.fileUri && event.fileUri && event.fileUri !== errorEvent.fileUri) {
            continue;
        }

        if (isCodeModified(event)) {
            entries.push({
                eventId: event.id,
                kind: 'code_modified',
                timestamp: event.timestamp,
                label: '修改了代码',
                changedLines: countChangedLines(event.diff),
            });
        } else if (isHintRequested(event)) {
            // relatedCompileEventId 精确关联优先;未带关联时同窗口兜底。
            const related =
                event.relatedCompileEventId === errorEvent.id ||
                event.relatedCompileEventId === undefined;
            if (related) {
                const intentLabel = HINT_INTENT_LABELS[event.intent] ?? '提问';
                entries.push({
                    eventId: event.id,
                    kind: 'hint_requested',
                    timestamp: event.timestamp,
                    label: `求助了 AI(${intentLabel})`,
                });
            }
        } else if (isRunError(event)) {
            // run 条目期 3(#12b)再补跳 Run Panel;先做类型就绪的事实呈现。
            entries.push({
                eventId: event.id,
                kind: 'run_error',
                timestamp: event.timestamp,
                label: `运行出错(退出码 ${event.exitCode ?? '未知'})`,
            });
        } else if (isCompileSuccess(event)) {
            entries.push({
                eventId: event.id,
                kind: 'compile_success',
                timestamp: event.timestamp,
                label: '编译成功 ✓',
            });
        } else if (isCompileError(event)) {
            entries.push({
                eventId: event.id,
                kind: 'compile_error',
                timestamp: event.timestamp,
                label: `再次编译失败(${countDiagnosableErrors(event.parsedErrors)} 个错误)`,
            });
        }
    }

    return entries.sort((a, b) => a.timestamp - b.timestamp);
}

function representativePosition(
    card: KnowledgeCard,
    sortedEvents: DebugEvent[]
): { fileUri?: string; line?: number } {
    const parsed = pickRepresentativeError(card, sortedEvents);
    if (!parsed) {
        return {};
    }
    return { fileUri: parsed.file, line: parsed.line };
}

/**
 * 事件数组 → Journey 面板完整视图模型(纯函数)。
 * 未解决 episode 天然置顶;错题卡沿用 mergeAndSortKnowledgeCards 的排序。
 */
export function buildJourneyViewModel(events: DebugEvent[]): JourneyViewModel {
    const sortedEvents = [...events].sort((a, b) => a.timestamp - b.timestamp);
    const lifecycles = buildErrorLifecycles(sortedEvents);

    const episodes: JourneyEpisodeVM[] = [];
    for (const lifecycle of lifecycles) {
        const errorEvent = sortedEvents.find((e) => e.id === lifecycle.errorEventId);
        if (!errorEvent || !isCompileError(errorEvent)) {
            continue;
        }
        const parsed = errorEvent.parsedErrors.find(
            (p) => p.severity === 'error' || p.severity === 'warning'
        );
        episodes.push({
            errorEventId: errorEvent.id,
            message: parsed?.message ?? '',
            fileUri: errorEvent.fileUri,
            fileName: baseFileName(errorEvent.fileUri),
            line: parsed?.line,
            firstSeenAt: lifecycle.firstSeenAt,
            resolvedAt: lifecycle.resolvedAt,
            resolved: lifecycle.resolvedAt !== undefined,
            attemptsBeforeResolve: lifecycle.attemptsBeforeResolve,
            entries: buildEntriesForLifecycle(lifecycle, errorEvent, sortedEvents),
        });
    }

    const unresolved = episodes
        .filter((e) => !e.resolved)
        .sort((a, b) => b.firstSeenAt - a.firstSeenAt);
    const resolvedEpisodes = episodes
        .filter((e) => e.resolved)
        .sort((a, b) => b.firstSeenAt - a.firstSeenAt);

    const metricsBase = computeDebugMetrics(sortedEvents, lifecycles);
    const resolvedLifecycles = lifecycles.filter((l) => l.resolvedAt !== undefined);
    const avgFixAttemptsResolved =
        resolvedLifecycles.length > 0
            ? resolvedLifecycles.reduce((sum, l) => sum + l.attemptsBeforeResolve, 0) /
              resolvedLifecycles.length
            : 0;

    // 错题卡:与既有导出通路(buildKnowledgeCards)同一组合成逻辑,只是输入
    // 改为已取好的事件数组,保持纯函数。
    const allCards: KnowledgeCard[] = [];
    for (const event of sortedEvents) {
        if (!isCompileError(event)) {
            continue;
        }
        allCards.push(...generateKnowledgeCard(event, sortedEvents, lifecycles));
    }
    const mergedCards = mergeAndSortKnowledgeCards(allCards);
    const mistakeCards: MistakeCardVM[] = mergedCards.map((card) => ({
        tag: card.tag,
        title: card.title,
        phenomenon: pickRepresentativeError(card, sortedEvents)?.message ?? card.wrongExample,
        commonCauses: [...card.commonCauses],
        checkMethod: card.checkMethod,
        fixes: card.concreteFixes.map((fix) => ({ ...fix })),
        frequency: card.frequency,
        resolvedCount: card.resolvedCount,
        unresolvedCount: card.unresolvedCount,
        lastSeenAt: card.lastSeenAt,
        ...representativePosition(card, sortedEvents),
    }));

    return {
        generatedAt: Date.now(),
        metrics: {
            totalEvents: sortedEvents.length,
            resolvedErrors: resolvedLifecycles.length,
            unresolvedErrors: lifecycles.length - resolvedLifecycles.length,
            avgFixAttempts: avgFixAttemptsResolved,
            helpSeekingRatio: metricsBase.helpSeekingRatio,
            independentFixRatio: metricsBase.independentFixRatio,
        },
        episodes: [...unresolved, ...resolvedEpisodes],
        mistakeCards,
    };
}
