import type { DebugJourneyStore } from './debugJourneyStore';
import {
    aggregateErrorStats,
    aggregateHintStats,
    aggregateSessionStats,
    aggregateTimeStats,
    computeDebugMetrics,
} from './analytics';
import { buildConceptProfile } from './conceptProfiling';
import { buildErrorLifecycles } from './errorLifecycle';
import type {
    ErrorStatistics,
    HintStatistics,
    SessionStatistics,
    TimeStatistics,
    DebugMetrics,
    ConceptProfile,
} from './analytics';
import type { ErrorLifecycle } from './errorLifecycle';

export interface JourneySummary {
    workspaceId: string;
    fileUri?: string;
    since?: number;
    totalEvents: number;
    errorStats: ErrorStatistics;
    hintStats: HintStatistics;
    timeStats: TimeStatistics;
    metrics: DebugMetrics;
    conceptProfiles: ConceptProfile[];
    lifecycles: ErrorLifecycle[];
    sessionStats: SessionStatistics[];
    suggestedSteps: string[];
}

export async function buildJourneySummary(
    store: DebugJourneyStore,
    options?: { fileUri?: string; since?: number }
): Promise<JourneySummary> {
    const events = await store.getEvents({
        fileUri: options?.fileUri,
        since: options?.since,
    });

    const filterOptions = {
        fileUri: options?.fileUri,
        since: options?.since,
    };

    const errorStats = aggregateErrorStats(events, filterOptions);
    const timeStats = aggregateTimeStats(events);
    const lifecycles = buildErrorLifecycles(events, {
        fileUri: options?.fileUri,
    });
    const hintStats = aggregateHintStats(events, lifecycles);
    const metrics = computeDebugMetrics(events, lifecycles);
    const conceptProfiles = buildConceptProfile(events, lifecycles);
    const sessionStats = aggregateSessionStats(events, filterOptions);

    const suggestedSteps = generateSuggestedSteps(
        events,
        errorStats,
        conceptProfiles,
        metrics,
        lifecycles
    );

    return {
        workspaceId: store.workspaceId,
        fileUri: options?.fileUri,
        since: options?.since,
        totalEvents: events.length,
        errorStats,
        hintStats,
        timeStats,
        metrics,
        conceptProfiles,
        lifecycles,
        sessionStats,
        suggestedSteps,
    };
}

function generateSuggestedSteps(
    events: unknown[],
    errorStats: ErrorStatistics,
    conceptProfiles: ConceptProfile[],
    metrics: DebugMetrics,
    lifecycles: ErrorLifecycle[]
): string[] {
    const steps: string[] = [];

    if (events.length === 0) {
        steps.push('No debug events recorded yet.');
        return steps;
    }

    steps.push(`Recorded ${events.length} debug events in total.`);
    steps.push(
        `Compile outcomes: ${errorStats.totalCompileErrors} error(s), ${errorStats.totalCompileSuccesses} success(es).`
    );

    const resolvedCount = lifecycles.filter((l) => l.resolvedAt).length;
    const unresolvedCount = lifecycles.length - resolvedCount;
    steps.push(
        `Tracked ${lifecycles.length} error lifecycles: ${resolvedCount} resolved, ${unresolvedCount} unresolved.`
    );

    if (metrics.avgFixAttempts > 0) {
        steps.push(`Average fix attempts per error: ${metrics.avgFixAttempts.toFixed(1)}.`);
    }

    if (conceptProfiles.length > 0) {
        const top = conceptProfiles[0];
        steps.push(
            `Top struggle area: ${top.tag} (${top.occurrenceCount} occurrence(s), ${top.unresolvedCount} unresolved).`
        );
    }

    const topTag = Object.entries(errorStats.byKnowledgeTag)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 1)[0];
    if (topTag) {
        steps.push(`Most common knowledge tag: ${topTag[0]} (${topTag[1]} time(s)).`);
    }

    if (metrics.helpSeekingRatio > 0.5) {
        steps.push('You often request hints while debugging — try predicting the cause before asking.');
    } else if (metrics.independentFixRatio > 0.5) {
        steps.push('Great: most of your resolved errors were fixed without hints.');
    }

    return steps;
}
