import type { DebugJourneyStore } from './debugJourneyStore';
import { buildErrorLifecycles, type ErrorLifecycle } from './errorLifecycle';
import {
    generateKnowledgeCard,
    generateRunErrorKnowledgeCard,
    mergeAndSortKnowledgeCards,
    type KnowledgeCard,
} from './knowledgeCard';
import { isCompileError, isRunError, type DebugEvent } from './types';

export interface BuildKnowledgeCardsOptions {
    fileUri?: string;
    since?: number;
    maxConcreteExamples?: number;
}

export interface BuildKnowledgeCardsFromEventsOptions {
    maxConcreteExamples?: number;
    resolvedMarks?: Record<string, number>;
    /** Journey 已经计算过生命周期时可复用，避免重复派生。 */
    lifecycles?: ErrorLifecycle[];
}

/** 事件数组 → compile/run 统一知识卡，供 Journey 与 store 入口共用。 */
export function buildKnowledgeCardsFromEvents(
    events: DebugEvent[],
    options?: BuildKnowledgeCardsFromEventsOptions
): KnowledgeCard[] {
    const lifecycles = options?.lifecycles ?? buildErrorLifecycles(events);
    const allCards: KnowledgeCard[] = [];
    for (const event of events) {
        if (isCompileError(event)) {
            allCards.push(...generateKnowledgeCard(event, events, lifecycles, {
                maxConcreteExamples: options?.maxConcreteExamples,
            }));
        } else if (isRunError(event)) {
            allCards.push(
                generateRunErrorKnowledgeCard(event, events, options?.resolvedMarks)
            );
        }
    }
    return mergeAndSortKnowledgeCards(allCards);
}

/**
 * Build the full deduplicated and sorted knowledge-card list for a workspace.
 *
 * The function reads relevant events plus the student's manual resolved marks,
 * generates compile and run cards, then merges cards by tag and sorts them using
 * the same rules as `ConceptProfile`.
 */
export async function buildKnowledgeCards(
    store: DebugJourneyStore,
    options?: BuildKnowledgeCardsOptions
): Promise<KnowledgeCard[]> {
    const events = await store.getEvents({
        fileUri: options?.fileUri,
        since: options?.since,
    });

    const resolvedMarks = await store.getResolvedMarks();
    return buildKnowledgeCardsFromEvents(events, {
        maxConcreteExamples: options?.maxConcreteExamples,
        resolvedMarks,
        lifecycles: buildErrorLifecycles(events, { fileUri: options?.fileUri }),
    });
}
