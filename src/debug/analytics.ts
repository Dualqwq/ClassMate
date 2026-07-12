import type { MessageIntent } from '../chat/types';
import type {
    CodeModifiedEvent,
    CompileErrorEvent,
    CompileSuccessEvent,
    DebugEvent,
    RunErrorEvent,
} from './types';
import { isCodeModified, isCompileError, isCompileSuccess, isHintRequested, isRunError } from './types';
import { createErrorSignature } from './errorFingerprint';
import type { ErrorLifecycle } from './errorLifecycle';

export interface ErrorStatistics {
    totalCompileErrors: number;
    totalCompileSuccesses: number;
    totalRunErrors: number;
    byErrorCode: Record<string, number>;
    byKnowledgeTag: Record<string, number>;
    byFile: Record<string, number>;
    bySeverity: Record<string, number>;
}

export interface HintStatistics {
    totalHints: number;
    byIntent: Partial<Record<MessageIntent, number>>;
    avgHintsBeforeSuccess: number;
    unresolvedHintRatio: number;
}

export interface TimeStatistics {
    totalCompileDurationMs: number;
    avgCompileDurationMs: number;
    medianCompileDurationMs: number;
}

export interface SessionStatistics {
    sessionId: string;
    eventCount: number;
    compileErrors: number;
    compileSuccesses: number;
    runErrors: number;
    hints: number;
    firstEventAt: number;
    lastEventAt: number;
    durationMs: number;
}

export interface DebugMetrics {
    /** Proportion of compiles that end in error. */
    errorRate: number;
    /** Proportion of errors that recur within their lifecycle window. */
    repeatedErrorDensity: number;
    /** Proportion of error lifecycles that include at least one hint request. */
    helpSeekingRatio: number;
    /** Proportion of resolved lifecycles with no hint request. */
    independentFixRatio: number;
    /** Average compile attempts before an error is resolved. */
    avgFixAttempts: number;
}

export interface ConceptProfile {
    tag: string;
    occurrenceCount: number;
    resolvedCount: number;
    unresolvedCount: number;
    avgFixAttempts: number;
    lastSeenAt: number;
}

export interface AggregationOptions {
    since?: number;
    until?: number;
    fileUri?: string;
}

function filterEvents(events: DebugEvent[], options?: AggregationOptions): DebugEvent[] {
    return events.filter((e) => {
        if (options?.since && e.timestamp < options.since) {
            return false;
        }
        if (options?.until && e.timestamp > options.until) {
            return false;
        }
        if (options?.fileUri && e.fileUri !== options.fileUri) {
            return false;
        }
        return true;
    });
}

function median(values: number[]): number {
    if (values.length === 0) {
        return 0;
    }
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[mid];
}

export function aggregateErrorStats(
    events: DebugEvent[],
    options?: AggregationOptions
): ErrorStatistics {
    const filtered = filterEvents(events, options);

    const stats: ErrorStatistics = {
        totalCompileErrors: 0,
        totalCompileSuccesses: 0,
        totalRunErrors: 0,
        byErrorCode: {},
        byKnowledgeTag: {},
        byFile: {},
        bySeverity: {},
    };

    for (const event of filtered) {
        if (isCompileError(event)) {
            stats.totalCompileErrors += 1;
            for (const parsed of event.parsedErrors) {
                const code = parsed.code ?? 'unknown';
                stats.byErrorCode[code] = (stats.byErrorCode[code] ?? 0) + 1;

                const severity = parsed.severity ?? 'error';
                stats.bySeverity[severity] = (stats.bySeverity[severity] ?? 0) + 1;

                const signature = createErrorSignature(parsed, { includeCode: false, includeFile: false });
                for (const tag of signature.knowledgeTags) {
                    stats.byKnowledgeTag[tag] = (stats.byKnowledgeTag[tag] ?? 0) + 1;
                }

                if (parsed.file) {
                    stats.byFile[parsed.file] = (stats.byFile[parsed.file] ?? 0) + 1;
                }
            }
        } else if (isCompileSuccess(event)) {
            stats.totalCompileSuccesses += 1;
        } else if (isRunError(event)) {
            stats.totalRunErrors += 1;
        }
    }

    return stats;
}

export function aggregateHintStats(
    events: DebugEvent[],
    lifecycles?: ErrorLifecycle[]
): HintStatistics {
    const filtered = events.filter(isHintRequested);

    const byIntent: Partial<Record<MessageIntent, number>> = {};
    for (const event of filtered) {
        byIntent[event.intent] = (byIntent[event.intent] ?? 0) + 1;
    }

    let unresolvedHintCount = 0;
    if (lifecycles) {
        for (const lifecycle of lifecycles) {
            if (!lifecycle.resolvedAt) {
                const hintsDuring = events.filter(
                    (e) =>
                        isHintRequested(e) &&
                        e.timestamp >= lifecycle.firstSeenAt &&
                        (!lifecycle.resolvedAt || e.timestamp <= lifecycle.resolvedAt)
                ).length;
                if (hintsDuring > 0) {
                    unresolvedHintCount += 1;
                }
            }
        }
    }

    const resolvedLifecycles = lifecycles?.filter((l) => l.resolvedAt) ?? [];
    const totalHintsBeforeSuccess = resolvedLifecycles.reduce((sum, l) => {
        const hintsBefore = events.filter(
            (e) =>
                isHintRequested(e) &&
                e.timestamp >= l.firstSeenAt &&
                e.timestamp <= l.resolvedAt!
        ).length;
        return sum + hintsBefore;
    }, 0);

    return {
        totalHints: filtered.length,
        byIntent,
        avgHintsBeforeSuccess:
            resolvedLifecycles.length > 0
                ? totalHintsBeforeSuccess / resolvedLifecycles.length
                : 0,
        unresolvedHintRatio:
            lifecycles && lifecycles.length > 0
                ? unresolvedHintCount / lifecycles.length
                : 0,
    };
}

export function aggregateTimeStats(events: DebugEvent[]): TimeStatistics {
    const compileEvents = events.filter(
        (e): e is CompileErrorEvent | CompileSuccessEvent => isCompileError(e) || isCompileSuccess(e)
    );

    const durations = compileEvents.map((e) => e.durationMs ?? 0);
    const total = durations.reduce((sum, d) => sum + d, 0);

    return {
        totalCompileDurationMs: total,
        avgCompileDurationMs: durations.length > 0 ? total / durations.length : 0,
        medianCompileDurationMs: median(durations),
    };
}

export function aggregateSessionStats(
    events: DebugEvent[],
    options?: AggregationOptions
): SessionStatistics[] {
    const filtered = filterEvents(events, options);
    const bySession = new Map<string, SessionStatistics>();

    for (const event of filtered) {
        let session = bySession.get(event.sessionId);
        if (!session) {
            session = {
                sessionId: event.sessionId,
                eventCount: 0,
                compileErrors: 0,
                compileSuccesses: 0,
                runErrors: 0,
                hints: 0,
                firstEventAt: event.timestamp,
                lastEventAt: event.timestamp,
                durationMs: 0,
            };
            bySession.set(event.sessionId, session);
        }

        session.eventCount += 1;
        session.firstEventAt = Math.min(session.firstEventAt, event.timestamp);
        session.lastEventAt = Math.max(session.lastEventAt, event.timestamp);

        if (isCompileError(event)) {
            session.compileErrors += 1;
        } else if (isCompileSuccess(event)) {
            session.compileSuccesses += 1;
        } else if (isRunError(event)) {
            session.runErrors += 1;
        } else if (isHintRequested(event)) {
            session.hints += 1;
        }
    }

    for (const session of bySession.values()) {
        session.durationMs = session.lastEventAt - session.firstEventAt;
    }

    return [...bySession.values()].sort((a, b) => a.firstEventAt - b.firstEventAt);
}

export function computeDebugMetrics(
    events: DebugEvent[],
    lifecycles: ErrorLifecycle[]
): DebugMetrics {
    const compileEvents = events.filter(
        (e): e is CompileErrorEvent | CompileSuccessEvent => isCompileError(e) || isCompileSuccess(e)
    );
    const errorCount = compileEvents.filter(isCompileError).length;
    const errorRate = compileEvents.length > 0 ? errorCount / compileEvents.length : 0;

    const unresolvedCount = lifecycles.filter((l) => !l.resolvedAt).length;
    const repeatedErrorDensity = lifecycles.length > 0 ? unresolvedCount / lifecycles.length : 0;

    let lifecyclesWithHints = 0;
    let resolvedWithoutHints = 0;
    let totalAttempts = 0;

    for (const lifecycle of lifecycles) {
        const hintsDuring = events.filter(
            (e) =>
                isHintRequested(e) &&
                e.timestamp >= lifecycle.firstSeenAt &&
                (!lifecycle.resolvedAt || e.timestamp <= lifecycle.resolvedAt)
        ).length;

        if (hintsDuring > 0) {
            lifecyclesWithHints += 1;
        }

        if (lifecycle.resolvedAt && hintsDuring === 0) {
            resolvedWithoutHints += 1;
        }

        totalAttempts += lifecycle.attemptsBeforeResolve;
    }

    const resolvedCount = lifecycles.filter((l) => l.resolvedAt).length;

    return {
        errorRate,
        repeatedErrorDensity,
        helpSeekingRatio: lifecycles.length > 0 ? lifecyclesWithHints / lifecycles.length : 0,
        independentFixRatio: resolvedCount > 0 ? resolvedWithoutHints / resolvedCount : 0,
        avgFixAttempts: lifecycles.length > 0 ? totalAttempts / lifecycles.length : 0,
    };
}

export function aggregateErrorStatsByDay(
    events: DebugEvent[]
): Record<string, ErrorStatistics> {
    const byDay: Record<string, DebugEvent[]> = {};

    for (const event of events) {
        const date = new Date(event.timestamp).toISOString().slice(0, 10);
        byDay[date] = byDay[date] ?? [];
        byDay[date].push(event);
    }

    const result: Record<string, ErrorStatistics> = {};
    for (const [date, dayEvents] of Object.entries(byDay)) {
        result[date] = aggregateErrorStats(dayEvents);
    }

    return result;
}
