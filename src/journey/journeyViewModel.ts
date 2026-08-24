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
    isRunSuccess,
    type CompileErrorEvent,
    type DebugEvent,
} from '../debug/types';
import { RUN_ERROR_KIND_LABELS, type RunErrorKind } from '../run/runErrorKind';

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
    kind:
        | 'compile_error'
        | 'compile_success'
        | 'code_modified'
        | 'hint_requested'
        | 'run_error'
        | 'run_success';
    timestamp: number;
    /** 学生化摘要文案(不含内部术语),如「编译失败(2 个错误)」。 */
    label: string;
    /** code_modified 条目:本次编辑增删行数([看 diff] 用 journey:openDiff)。 */
    changedLines?: number;
    /** run_error 条目专用:分类标签(run 错误分类过滤用)。 */
    runErrorKind?: RunErrorKind;
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
     * 诊断级别(error/warning/info):折叠按「事件+签名+级别」成卡,
     * 同一位置的 error 与 warning 是两张卡。旧视图模型缺省按 error 呈现;
     * run_success 独立卡用 info(中性呈现,不冒充错误)。
     */
    severity?: 'error' | 'warning' | 'info';
    firstSeenAt: number;
    resolvedAt?: number;
    resolved: boolean;
    attemptsBeforeResolve: number;
    /** 生命周期内按时间升序的条目(起始编译失败必为第一条)。 */
    entries: JourneyEntryVM[];
    /** run_error 独立 episode 专用:分类标签(kind 过滤与学生化文案用)。 */
    runErrorKind?: RunErrorKind;
    /**
     * 题目分组键(错题本「按题目」分组,#14b):由 fileUri 文件名去扩展名
     * 派生(main.cpp 与 main.exe 归并为同一题);后续可升级为读取 question.md
     * 或 PDF 标题。
     */
    problemKey?: string;
    /**
     * 学生手动标记的已解决(run_error 独立卡专用):与自动生命周期解决
     * (resolved)区分开,供 UI 呈现「学生自己拍板」的视觉与撤销入口。
     */
    resolvedByStudent?: boolean;
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
    /**
     * 题目分组键(「按题目」分组用):由代表性错误的报错文件名去扩展名
     * 派生;头文件错误会指向头文件名,属已知近似。
     */
    problemKey?: string;
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

/**
 * 题目分组键(#14b):文件名去扩展名。main.cpp 与 main.exe 归并为同一题,
 * 让「编译失败 → 修改 → 运行出错」能挂到同一题目下;解不出时返回 undefined。
 */
export function deriveProblemKey(fileUri: string | undefined): string | undefined {
    const base = baseFileName(fileUri);
    if (!base) {
        return undefined;
    }
    const dot = base.lastIndexOf('.');
    const stem = dot > 0 ? base.slice(0, dot) : base;
    return stem.length > 0 ? stem : undefined;
}

/** run 条目的学生化文案:「运行出错：数组越界(退出码 139)」/「运行成功 ✓」。
 * detail 为分类器给出的事实性描述(如陌生异常类名)，仅转述不推断。 */
function describeRunOutcome(exitCode: number | null, kind?: RunErrorKind, detail?: string): string {
    if (!kind) {
        return '运行成功 ✓';
    }
    const base = `${RUN_ERROR_KIND_LABELS[kind]}(退出码 ${exitCode ?? '未知'})`;
    return detail ? `${base}；${detail}` : base;
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
    // run 条目按题目键归并(main.cpp / main.exe → main):run 事件的 fileUri
    // 是 exe 路径,与编译错误的源文件 URI 永不相等,精确匹配会让运行记录
    // 永远进不了编译 episode 的条目流。
    const errorProblemKey = deriveProblemKey(errorEvent.fileUri);
    for (const event of sortedEvents) {
        if (event.id === errorEvent.id) {
            continue;
        }
        if (event.timestamp <= errorEvent.timestamp || event.timestamp > windowEnd) {
            continue;
        }
        // 只串同一文件的修复过程;无文件信息的错误不设此限制。run 条目用
        // 题目键比较(见上),其余类型仍要求 fileUri 精确一致。
        if (errorEvent.fileUri && event.fileUri) {
            const sameSource = isRunError(event) || isRunSuccess(event)
                ? deriveProblemKey(event.fileUri) === errorProblemKey &&
                  errorProblemKey !== undefined
                : event.fileUri === errorEvent.fileUri;
            if (!sameSource) {
                continue;
            }
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
            // 运行结果接入(#12b):按分类给学生化文案,kind 随条目带出供过滤。
            entries.push({
                eventId: event.id,
                kind: 'run_error',
                timestamp: event.timestamp,
                label: describeRunOutcome(event.exitCode, event.kind, event.errorDetail),
                runErrorKind: event.kind,
            });
        } else if (isRunSuccess(event)) {
            entries.push({
                eventId: event.id,
                kind: 'run_success',
                timestamp: event.timestamp,
                label: describeRunOutcome(event.exitCode),
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
export function buildJourneyViewModel(
    events: DebugEvent[],
    options?: { resolvedMarks?: Record<string, number> }
): JourneyViewModel {
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

    // run 条目(#12b/#14b):每次运行独立成 episode。run 事件的 fileUri 是
    // exe 路径,走不了 compile_error 生命周期;独立成卡保证没有编译失败历史
    // 时(如直接运行成功/超时)运行记录也可见。run_error 未解决置顶,
    // run_success 按 info 级别进已解决日折叠区。
    //
    // 学生手动「已解决」(产品拍板:解决判定权完全在学生,不做自动判定):
    // 重置语义按时间戳纯派生——标记只在该题「没有更新的 run_error」时有效,
    // 同题再犯即回到未解决;run_success 不参与比较,绝不自动翻转解决态。
    const resolvedMarks = options?.resolvedMarks ?? {};
    const latestRunErrorAt = new Map<string, number>();
    for (const event of sortedEvents) {
        if (!isRunError(event)) {
            continue;
        }
        const pk = deriveProblemKey(event.fileUri);
        if (!pk) {
            continue;
        }
        latestRunErrorAt.set(pk, Math.max(latestRunErrorAt.get(pk) ?? 0, event.timestamp));
    }
    for (const event of sortedEvents) {
        if (isRunError(event)) {
            const problemKey = deriveProblemKey(event.fileUri);
            const markedAt =
                problemKey !== undefined ? resolvedMarks[problemKey] : undefined;
            const latestErrorAt =
                problemKey !== undefined ? latestRunErrorAt.get(problemKey) : undefined;
            const studentResolved =
                markedAt !== undefined &&
                latestErrorAt !== undefined &&
                markedAt >= latestErrorAt;
            episodes.push({
                errorEventId: event.id,
                message: describeRunOutcome(event.exitCode, event.kind, event.errorDetail),
                fileUri: event.fileUri,
                fileName: baseFileName(event.fileUri),
                severity: 'error',
                runErrorKind: event.kind,
                firstSeenAt: event.timestamp,
                resolved: studentResolved,
                ...(studentResolved
                    ? { resolvedAt: markedAt, resolvedByStudent: true as const }
                    : {}),
                attemptsBeforeResolve: 0,
                entries: [
                    {
                        eventId: event.id,
                        kind: 'run_error',
                        timestamp: event.timestamp,
                        label: describeRunOutcome(event.exitCode, event.kind, event.errorDetail),
                        runErrorKind: event.kind,
                    },
                ],
                problemKey,
            });
            continue;
        }
        if (!isRunSuccess(event)) {
            continue;
        }
        episodes.push({
            errorEventId: event.id,
            message: describeRunOutcome(event.exitCode),
            fileUri: event.fileUri,
            fileName: baseFileName(event.fileUri),
            severity: 'info',
            firstSeenAt: event.timestamp,
            resolved: true,
            attemptsBeforeResolve: 0,
            entries: [
                {
                    eventId: event.id,
                    kind: 'run_success',
                    timestamp: event.timestamp,
                    label: describeRunOutcome(event.exitCode),
                },
            ],
            problemKey: deriveProblemKey(event.fileUri),
        });
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
    const mistakeCards: MistakeCardVM[] = mergedCards.map((card) => {
        const representative = pickRepresentativeError(card, sortedEvents);
        return {
            tag: card.tag,
            title: card.title,
            phenomenon: representative?.message ?? card.wrongExample,
            commonCauses: [...card.commonCauses],
            checkMethod: card.checkMethod,
            fixes: card.concreteFixes.map((fix) => ({ ...fix })),
            frequency: card.frequency,
            resolvedCount: card.resolvedCount,
            unresolvedCount: card.unresolvedCount,
            lastSeenAt: card.lastSeenAt,
            ...representativePosition(card, sortedEvents),
            // 「按题目」分组键(#14b):代表性报错文件名去扩展名;头文件错误
            // 会归到头文件名下,属已知近似(设计笔记遗留问题)。
            problemKey: deriveProblemKey(representative?.file),
        };
    });

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
