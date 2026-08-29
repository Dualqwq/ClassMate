import type { ParsedError } from '../error/errorParser';
import { getKnowledgeConcept, matchErrorToKnowledge } from '../error/errorKnowledgeMap';
import { resolveAttributedError } from '../error/templateBacktrace';
import { matchTemplateErrorToKnowledge } from '../error/templateKnowledgeSignatures';
import { createErrorSignature, signatureKey, signaturesMatch } from './errorFingerprint';
import type { ErrorLifecycle } from './errorLifecycle';
import { findFixingEdits } from './errorLifecycle';
import { formatFixAsDiff, normalizeCodeForDiff } from './formatDiff';
import { eventProblemKey } from './problemKey';
import type { CompileErrorEvent, DebugEvent, RunErrorEvent } from './types';
import {
    formatRunErrorPhenomenon,
    getRunErrorKnowledgeConcept,
} from '../run/runErrorKnowledgeMap';

const DEFAULT_MAX_CONCRETE_EXAMPLES = 3;

export interface ConcreteFix {
    before: string;
    after: string;
    diff: string;
}

export interface KnowledgeCard {
    tag: string;
    title: string;
    summary: string;
    commonCauses: string[];
    suggestedFixes: string[];
    checkMethod: string;
    wrongExample: string;
    correctExample: string;

    frequency: number;
    resolvedCount: number;
    unresolvedCount: number;
    avgFixAttempts: number;
    lastSeenAt: number;

    sourceEvents: string[];
    correctingEditIds: string[];
    concreteFixes: ConcreteFix[];

    /** 最近一次运行 occurrence 的事实性现象；编译卡沿用 representative error。 */
    phenomenon?: string;
    /** 最近一次运行 occurrence 的事件位置，只到已有 fileUri，不编造行号。 */
    fileUri?: string;
    /** 全局 tag 卡的最新代表 occurrence 所属题目。 */
    problemKey?: string;
    /** 运行卡固定为 error；编译卡继续从 representative diagnostic 派生。 */
    severity?: 'error' | 'warning';
}

export interface GenerateCardOptions {
    maxConcreteExamples?: number;
}

function makeFixDedupKey(before: string, after: string): string {
    return `${normalizeCodeForDiff(before)}\n---\n${normalizeCodeForDiff(after)}`;
}

function collectConcreteFixes(
    editIds: string[],
    allEvents: DebugEvent[],
    maxExamples: number
): ConcreteFix[] {
    const fixes: ConcreteFix[] = [];
    const seen = new Set<string>();

    for (const editId of editIds) {
        if (fixes.length >= maxExamples) {
            break;
        }
        const edit = allEvents.find((e) => e.id === editId && e.type === 'code_modified');
        if (!edit || edit.type !== 'code_modified') {
            continue;
        }
        if (!edit.before.trim() && !edit.after.trim()) {
            continue;
        }

        const key = makeFixDedupKey(edit.before, edit.after);
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);

        fixes.push({
            before: edit.before,
            after: edit.after,
            diff: formatFixAsDiff(edit.before, edit.after),
        });
    }

    return fixes;
}

function computeCardStats(
    lifecycle: ErrorLifecycle | undefined,
    timestamp: number
): Pick<
    KnowledgeCard,
    'frequency' | 'resolvedCount' | 'unresolvedCount' | 'avgFixAttempts' | 'lastSeenAt'
> {
    if (!lifecycle) {
        return {
            frequency: 1,
            resolvedCount: 0,
            unresolvedCount: 1,
            avgFixAttempts: 0,
            lastSeenAt: timestamp,
        };
    }

    return {
        frequency: 1,
        resolvedCount: lifecycle.resolvedAt ? 1 : 0,
        unresolvedCount: lifecycle.resolvedAt ? 0 : 1,
        avgFixAttempts: lifecycle.attemptsBeforeResolve,
        lastSeenAt: timestamp,
    };
}

/**
 * Generate one KnowledgeCard per matched knowledge tag for a single compile
 * error event. Cards from the same event are later merged across events by
 * `mergeKnowledgeCards`.
 */
export function generateKnowledgeCard(
    errorEvent: CompileErrorEvent,
    allEvents: DebugEvent[],
    lifecycles: ErrorLifecycle[],
    options?: GenerateCardOptions
): KnowledgeCard[] {
    const maxConcreteExamples = options?.maxConcreteExamples ?? DEFAULT_MAX_CONCRETE_EXAMPLES;
    const fixingEdits = findFixingEdits(errorEvent, allEvents);
    const cards: KnowledgeCard[] = [];

    for (const parsed of errorEvent.parsedErrors) {
        if (parsed.severity !== 'error' && parsed.severity !== 'warning') {
            continue;
        }

        const signature = createErrorSignature(parsed, { includeCode: false, includeFile: false });
        const signatureKeyValue = signatureKey(signature, { mode: 'knowledge' });

        // Pick the first knowledge tag that has a full concept entry. ERROR_PATTERNS
        // is ordered from most specific to most general, so the first match is the
        // best teaching target for this diagnostic.
        // 模板链签名表优先(P5b):STL 深处的叶子(如 sort+list 的
        // no match for 'operator-')通用表只能给"运算符不匹配"这类宽泛卡,
        // 链签名能给出"迭代器类别不满足算法要求"这类根因卡;未命中再回退。
        const matches = matchErrorToKnowledge(parsed.message);
        const templateMatches = matchTemplateErrorToKnowledge(parsed);
        const bestMatch =
            templateMatches.find((m) => getKnowledgeConcept(m.tag) !== undefined) ??
            matches.find((m) => getKnowledgeConcept(m.tag) !== undefined);
        if (!bestMatch) {
            continue;
        }

        const concept = getKnowledgeConcept(bestMatch.tag)!;
        const lifecycle = lifecycles.find(
            (l) =>
                l.errorEventId === errorEvent.id &&
                signaturesMatch(l.signature, signature, { mode: 'knowledge' })
        );
        const stats = computeCardStats(lifecycle, errorEvent.timestamp);

        const fixingResult = fixingEdits.find(
            (r) => signatureKey(r.signature, { mode: 'knowledge' }) === signatureKeyValue
        );
        const editIds: string[] = [];
        if (fixingResult?.edit) {
            editIds.push(fixingResult.edit.id);
        }

        const concreteFixes = collectConcreteFixes(editIds, allEvents, maxConcreteExamples);

        cards.push({
            tag: concept.tag,
            title: concept.title,
            summary: concept.summary,
            commonCauses: [...concept.commonCauses],
            suggestedFixes: [...concept.suggestedFixes],
            checkMethod: concept.checkMethod,
            wrongExample: concept.wrongExample,
            correctExample: concept.correctExample,
            ...stats,
            sourceEvents: [errorEvent.id],
            correctingEditIds: editIds,
            concreteFixes,
            // 题目分组键(run 条目归属 ②):宿主写事件时算好的材料键;
            // 旧事件无该字段时保持 undefined,由消费侧回退文件名 stem。
            ...(errorEvent.problemKey !== undefined ? { problemKey: errorEvent.problemKey } : {}),
        });
    }

    return cards;
}

/**
 * 由已分类的 run_error 生成一张 occurrence 卡。
 *
 * 不读取 stderr 再分类；解决态只按该 occurrence 自己的 problemKey 计算，
 * 也不把附近 code_modified 猜作“修复”。
 */
export function generateRunErrorKnowledgeCard(
    errorEvent: RunErrorEvent,
    allEvents: DebugEvent[],
    resolvedMarks: Record<string, number> = {}
): KnowledgeCard {
    const concept = getRunErrorKnowledgeConcept(errorEvent.kind);
    // 题目键优先事件字段(材料键/源文件归位),缺省回退 exe 文件名 stem——
    // 旧持久化事件与现行 resolved.json 键的语义保持不变。
    const problemKey = eventProblemKey(errorEvent);
    const latestSameProblemErrorAt = problemKey === undefined
        ? undefined
        : allEvents.reduce<number | undefined>((latest, event) => {
            if (event.type !== 'run_error' || eventProblemKey(event) !== problemKey) {
                return latest;
            }
            return Math.max(latest ?? 0, event.timestamp);
        }, undefined);
    const markedAt = problemKey === undefined ? undefined : resolvedMarks[problemKey];
    const resolved =
        markedAt !== undefined &&
        latestSameProblemErrorAt !== undefined &&
        markedAt >= latestSameProblemErrorAt;

    return {
        tag: concept.tag,
        title: concept.title,
        summary: concept.summary,
        commonCauses: [...concept.commonCauses],
        suggestedFixes: [...concept.suggestedFixes],
        checkMethod: concept.checkMethod,
        wrongExample: concept.wrongExample,
        correctExample: concept.correctExample,
        frequency: 1,
        resolvedCount: resolved ? 1 : 0,
        unresolvedCount: resolved ? 0 : 1,
        avgFixAttempts: 0,
        lastSeenAt: errorEvent.timestamp,
        sourceEvents: [errorEvent.id],
        correctingEditIds: [],
        concreteFixes: [],
        phenomenon: formatRunErrorPhenomenon(
            errorEvent.kind,
            errorEvent.exitCode,
            errorEvent.errorDetail
        ),
        // 源文件归位(①):错题本跳转优先 exe 对应源文件;旧事件回退 exe 路径。
        fileUri: errorEvent.sourceFileUri ?? errorEvent.fileUri,
        problemKey,
        severity: 'error',
    };
}

/**
 * Merge knowledge cards that share the same tag, accumulating statistics and
 * deduplicating source events, edits, and concrete fixes.
 */
export function mergeKnowledgeCards(cards: KnowledgeCard[]): KnowledgeCard[] {
    const groups = new Map<string, KnowledgeCard[]>();

    for (const card of cards) {
        const group = groups.get(card.tag);
        if (group) {
            group.push(card);
        } else {
            groups.set(card.tag, [card]);
        }
    }

    const merged: KnowledgeCard[] = [];

    for (const group of groups.values()) {
        const first = group[0];
        // compile 卡保持既有 first 元数据语义；只有 runtime occurrence 带
        // phenomenon 时才选“最新 occurrence”作门面。同 timestamp 用事件 id
        // 稳定破平，避免输入数组顺序决定 phenomenon/fileUri/problemKey。
        const runtimeRepresentative = group
            .filter((card) => card.phenomenon !== undefined)
            .sort(byLatestOccurrence)[0];
        // 编译卡题目键传播(run 条目归属 ②):按 tag 全局合并的编译卡沿用
        // 「挂到最新代表题目」的既有口径,取最新一张带题目键的编译卡;
        // 组内无任何题目键时保持 undefined,消费侧回退代表性报错文件的
        // stem(现状行为,兼容旧事件)。
        const compileKeyRepresentative = group
            .filter((card) => card.phenomenon === undefined && card.problemKey !== undefined)
            .sort(byLatestOccurrence)[0];
        let frequency = 0;
        let resolvedCount = 0;
        let unresolvedCount = 0;
        let weightedAttempts = 0;
        let lastSeenAt = 0;
        const sourceEvents = new Set<string>();
        const correctingEditIds = new Set<string>();
        const concreteFixes: ConcreteFix[] = [];
        const seenFixes = new Set<string>();

        for (const card of group) {
            frequency += card.frequency;
            resolvedCount += card.resolvedCount;
            unresolvedCount += card.unresolvedCount;
            weightedAttempts += card.avgFixAttempts * card.frequency;
            lastSeenAt = Math.max(lastSeenAt, card.lastSeenAt);

            for (const id of card.sourceEvents) {
                sourceEvents.add(id);
            }
            for (const id of card.correctingEditIds) {
                correctingEditIds.add(id);
            }
            for (const fix of card.concreteFixes) {
                const key = makeFixDedupKey(fix.before, fix.after);
                if (!seenFixes.has(key)) {
                    seenFixes.add(key);
                    concreteFixes.push(fix);
                }
            }
        }

        merged.push({
            tag: first.tag,
            title: first.title,
            summary: first.summary,
            commonCauses: [...first.commonCauses],
            suggestedFixes: [...first.suggestedFixes],
            checkMethod: first.checkMethod,
            wrongExample: first.wrongExample,
            correctExample: first.correctExample,
            frequency,
            resolvedCount,
            unresolvedCount,
            avgFixAttempts: frequency > 0 ? weightedAttempts / frequency : 0,
            lastSeenAt,
            sourceEvents: [...sourceEvents],
            correctingEditIds: [...correctingEditIds],
            concreteFixes,
            ...(runtimeRepresentative
                ? {
                    phenomenon: runtimeRepresentative.phenomenon,
                    fileUri: runtimeRepresentative.fileUri,
                    problemKey: runtimeRepresentative.problemKey,
                    severity: runtimeRepresentative.severity,
                }
                : compileKeyRepresentative
                    ? { problemKey: compileKeyRepresentative.problemKey }
                    : {}),
        });
    }

    return merged;
}

/** 最新 occurrence 在前;同 lastSeenAt 用事件 id 稳定破平(降序)。 */
function byLatestOccurrence(a: KnowledgeCard, b: KnowledgeCard): number {
    if (b.lastSeenAt !== a.lastSeenAt) {
        return b.lastSeenAt - a.lastSeenAt;
    }
    const aId = a.sourceEvents[0] ?? '';
    const bId = b.sourceEvents[0] ?? '';
    return aId === bId ? 0 : aId < bId ? 1 : -1;
}

/**
 * Sort knowledge cards using the same priority as `ConceptProfile`:
 * unresolved count, then frequency, then average fix attempts, then last seen.
 */
export function sortKnowledgeCards(cards: KnowledgeCard[]): KnowledgeCard[] {
    return [...cards].sort((a, b) => {
        if (b.unresolvedCount !== a.unresolvedCount) {
            return b.unresolvedCount - a.unresolvedCount;
        }
        if (b.frequency !== a.frequency) {
            return b.frequency - a.frequency;
        }
        if (b.avgFixAttempts !== a.avgFixAttempts) {
            return b.avgFixAttempts - a.avgFixAttempts;
        }
        return b.lastSeenAt - a.lastSeenAt;
    });
}

/**
 * Convenience: merge and sort in one call.
 */
export function mergeAndSortKnowledgeCards(cards: KnowledgeCard[]): KnowledgeCard[] {
    return sortKnowledgeCards(mergeKnowledgeCards(cards));
}

export function pickRepresentativeError(card: KnowledgeCard, events: DebugEvent[]): ParsedError | undefined {
    for (const eventId of card.sourceEvents) {
        const event = events.find((e) => e.id === eventId && e.type === 'compile_error');
        if (!event || event.type !== 'compile_error') {
            continue;
        }
        for (const parsed of event.parsedErrors) {
            const matches = matchErrorToKnowledge(parsed.message);
            const templateMatches = matchTemplateErrorToKnowledge(parsed);
            if (matches.some((m) => m.tag === card.tag) || templateMatches.some((m) => m.tag === card.tag)) {
                // 模板链叶子(P5b):代表位置归因到最深学生代码帧——错题本卡片
                // 显示学生代码行而非 STL 行;无链时原样返回,零行为变化。
                return resolveAttributedError(parsed);
            }
        }
    }
    return undefined;
}
