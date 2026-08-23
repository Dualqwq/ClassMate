import type { ParsedError } from '../error/errorParser';
import { computeDebugMetrics } from '../debug/analytics';
import { computeEventFingerprint, SEMANTIC_DEDUPE_WINDOW_MS } from '../debug/eventEnvelope';
import {
    createErrorSignature,
    signatureKey,
    type ErrorSignature,
} from '../debug/errorFingerprint';
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
    type CompileErrorEvent,
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
    /** 起始 compile_error 事件 id;[求提示] 等以此定位。 */
    errorEventId: string;
    /** 首条错误原文 message(现象行)。 */
    message: string;
    /**
     * 跳转位置:优先诊断真实报错文件(parsed.file,含头文件错误场景),
     * 事件级 fileUri(主翻译单元)只作兜底——否则头文件错误会错跳到
     * include 它的 .cpp。
     */
    fileUri?: string;
    fileName?: string;
    line?: number;
    /** 该错误的 include 引入链路(从最内层到最外层,如 ["b.h:6","a.cpp:1"])。 */
    viaIncludes?: string[];
    /**
     * 诊断级别(error/warning):折叠按「事件+签名+级别」成卡,
     * 同一位置的 error 与 warning 是两张卡。旧视图模型缺省按 error 呈现。
     */
    severity?: 'error' | 'warning';
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
    /** [在代码里看] 定位:代表性错误的位置(真实报错文件)。 */
    fileUri?: string;
    line?: number;
    /** 代表性错误的 include 引入链路(卡片展示「经 X 引入」)。 */
    viaIncludes?: string[];
    /** 代表性错误的诊断级别(error/warning),卡片分级徽章用。 */
    severity?: 'error' | 'warning';
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

/**
 * 学生化计数:错误与警告分开写(如「3 个错误 · 2 个警告」);无警告时
 * 保持「N 个错误」的简洁形态。
 */
function describeDiagnosticCounts(parsedErrors: ParsedError[]): string {
    const errors = parsedErrors.filter((p) => p.severity === 'error').length;
    const warnings = parsedErrors.filter((p) => p.severity === 'warning').length;
    if (warnings === 0) {
        return `${errors} 个错误`;
    }
    return `${errors} 个错误 · ${warnings} 个警告`;
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
        label: `编译失败(${describeDiagnosticCounts(errorEvent.parsedErrors)})`,
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
                label: `再次编译失败(${describeDiagnosticCounts(event.parsedErrors)})`,
            });
        }
    }

    return entries.sort((a, b) => a.timestamp - b.timestamp);
}

function representativePosition(
    card: KnowledgeCard,
    sortedEvents: DebugEvent[]
): { fileUri?: string; line?: number; viaIncludes?: string[] } {
    const parsed = pickRepresentativeError(card, sortedEvents);
    if (!parsed) {
        return {};
    }
    return {
        fileUri: parsed.file,
        line: parsed.line,
        ...(parsed.severity === 'error' || parsed.severity === 'warning'
            ? { severity: parsed.severity }
            : {}),
        ...(parsed.viaIncludes ? { viaIncludes: [...parsed.viaIncludes] } : {}),
    };
}

/**
 * 语义折叠(消费侧兜底,复测问题 2):同指纹且时间相近的事件视为同一条
 * 逻辑错误的重复拷贝,只保留其中一条(取最新);时间相远的同指纹事件是
 * 学生真实的「又一次犯」,必须完整保留——否则时间线与版本链历史会被
 * 误吞。窗口口径与写入侧幂等窗口一致。
 */
function foldByFingerprint(events: DebugEvent[]): DebugEvent[] {
    const kept: DebugEvent[] = [];
    for (const event of events) {
        const key = event.fingerprint ?? computeEventFingerprint(event);
        const duplicateIndex = kept.findIndex((existing) => {
            const existingKey =
                existing.fingerprint ?? computeEventFingerprint(existing);
            return (
                existingKey === key &&
                Math.abs(existing.timestamp - event.timestamp) <= SEMANTIC_DEDUPE_WINDOW_MS
            );
        });
        if (duplicateIndex === -1) {
            kept.push(event);
            continue;
        }
        if (kept[duplicateIndex].timestamp <= event.timestamp) {
            kept[duplicateIndex] = event;
        }
    }
    return kept;
}

/**
 * 事件数组 → Journey 面板完整视图模型(纯函数)。
 * 未解决 episode 天然置顶;错题卡沿用 mergeAndSortKnowledgeCards 的排序。
 */
export function buildJourneyViewModel(events: DebugEvent[]): JourneyViewModel {
    const sortedEvents = [...foldByFingerprint(events)].sort((a, b) => a.timestamp - b.timestamp);
    const lifecycles = buildErrorLifecycles(sortedEvents);

    // ×8 根因修复(消费派生折叠):buildErrorLifecycles 对同一 compile_error
    // 事件的每条 error/warning 解析行各建一个 lifecycle,而卡片渲染若统一取
    // 「事件首条 message」,一次编译报 N 条诊断就会复制出 N 张一模一样的卡。
    // 先按事件分组(保持首次出现序),组内再按 fuzzy 签名折叠:同签名重复
    // 只出一张卡,不同签名是不同的错、各显自己的 message 与位置。
    const lifecyclesByEvent = new Map<string, ErrorLifecycle[]>();
    for (const lifecycle of lifecycles) {
        const group = lifecyclesByEvent.get(lifecycle.errorEventId);
        if (group) {
            group.push(lifecycle);
        } else {
            lifecyclesByEvent.set(lifecycle.errorEventId, [lifecycle]);
        }
    }

    const episodes: JourneyEpisodeVM[] = [];
    for (const [errorEventId, eventLifecycles] of lifecyclesByEvent) {
        const errorEvent = sortedEvents.find((e) => e.id === errorEventId);
        if (!errorEvent || !isCompileError(errorEvent)) {
            continue;
        }

        const bySignature = new Map<string, ErrorLifecycle[]>();
        for (const lifecycle of eventLifecycles) {
            // 折叠键含级别:同一位置的 error 与 warning 是不同的卡(签名
            // normalizedMessage 相同也不合并);跨事件重试史照旧各自成卡。
            const key = `${signatureKey(lifecycle.signature, { mode: 'fuzzy' })}::${
                lifecycle.signature.severity ?? ''
            }`;
            const group = bySignature.get(key);
            if (group) {
                group.push(lifecycle);
            } else {
                bySignature.set(key, [lifecycle]);
            }
        }

        for (const members of bySignature.values()) {
            const representative = members[0];
            // 折叠组的解决口径:整组签名都消失才算解决,窗口取最后消散时点,
            // 尝试次数取组内最大——与「这个错修了几次才好」的学生直觉一致。
            const resolvedAts = members
                .map((l) => l.resolvedAt)
                .filter((t): t is number => t !== undefined);
            const allResolved = resolvedAts.length === members.length;
            const foldedLifecycle: ErrorLifecycle = {
                ...representative,
                resolvedAt: allResolved ? Math.max(...resolvedAts) : undefined,
                attemptsBeforeResolve: Math.max(...members.map((l) => l.attemptsBeforeResolve)),
            };
            // 卡面与跳转用该签名自己的诊断行:头文件错误指向真实报错文件
            // (parsed.file=b.h),而非主翻译单元的事件级 fileUri(a.cpp);
            // 级别取签名自带 severity(折叠键已按 error/warning 分组)。
            const parsed = findParsedForSignature(errorEvent, representative.signature);
            const locationFile = parsed?.file ?? errorEvent.fileUri;
            episodes.push({
                errorEventId: errorEvent.id,
                message: parsed?.message ?? '',
                fileUri: locationFile,
                fileName: baseFileName(locationFile),
                line: parsed?.line,
                ...(parsed?.viaIncludes ? { viaIncludes: [...parsed.viaIncludes] } : {}),
                severity:
                    foldedLifecycle.signature.severity ??
                    (parsed?.severity === 'warning' ? 'warning' : 'error'),
                firstSeenAt: foldedLifecycle.firstSeenAt,
                resolvedAt: foldedLifecycle.resolvedAt,
                resolved: foldedLifecycle.resolvedAt !== undefined,
                attemptsBeforeResolve: foldedLifecycle.attemptsBeforeResolve,
                entries: buildEntriesForLifecycle(foldedLifecycle, errorEvent, sortedEvents),
            });
        }
    }

    const unresolved = episodes
        .filter((e) => !e.resolved)
        .sort((a, b) => b.firstSeenAt - a.firstSeenAt);
    const resolvedEpisodes = episodes
        .filter((e) => e.resolved)
        .sort((a, b) => b.firstSeenAt - a.firstSeenAt);

    const metricsBase = computeDebugMetrics(sortedEvents, lifecycles);
    // 求解状态类指标用折叠后的 episode 口径,与学生看到的卡数一致;
    // 求助比例/独立修复率是事件级比值,不受折叠影响。
    const resolvedEpisodeCount = resolvedEpisodes.length;
    const avgFixAttemptsResolved =
        resolvedEpisodeCount > 0
            ? resolvedEpisodes.reduce((sum, e) => sum + e.attemptsBeforeResolve, 0) /
              resolvedEpisodeCount
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
            resolvedErrors: resolvedEpisodeCount,
            unresolvedErrors: episodes.length - resolvedEpisodeCount,
            avgFixAttempts: avgFixAttemptsResolved,
            helpSeekingRatio: metricsBase.helpSeekingRatio,
            independentFixRatio: metricsBase.independentFixRatio,
        },
        episodes: [...unresolved, ...resolvedEpisodes],
        mistakeCards,
    };
}

/**
 * 在事件的解析诊断里找该签名的代表行(fuzzy:归一化 message 相同即同错),
 * 供折叠后的 episode 卡展示真实 message 与跳转位置。
 */
function findParsedForSignature(
    errorEvent: CompileErrorEvent,
    signature: ErrorSignature
): ParsedError | undefined {
    const key = signatureKey(signature, { mode: 'fuzzy' });
    return errorEvent.parsedErrors.find(
        (p) =>
            (p.severity === 'error' || p.severity === 'warning') &&
            // 级别一致才可作为该签名的代表行:error 组不得拿 warning 行当门面。
            (!signature.severity || p.severity === signature.severity) &&
            signatureKey(
                createErrorSignature(p, { includeCode: false, includeFile: false }),
                { mode: 'fuzzy' }
            ) === key
    );
}
