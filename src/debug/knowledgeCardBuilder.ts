import type { DebugJourneyStore } from './debugJourneyStore';
import { buildErrorLifecycles } from './errorLifecycle';
import {
    generateKnowledgeCard,
    mergeAndSortKnowledgeCards,
    type KnowledgeCard,
} from './knowledgeCard';
import { isCompileError } from './types';

export interface BuildKnowledgeCardsOptions {
    fileUri?: string;
    since?: number;
    maxConcreteExamples?: number;
}

/**
 * Build the full deduplicated and sorted knowledge-card list for a workspace.
 *
 * The function reads all relevant compile_error events from the store, computes
 * error lifecycles, generates one card per matched tag per event, then merges
 * cards by tag and sorts them using the same rules as `ConceptProfile`.
 */
export async function buildKnowledgeCards(
    store: DebugJourneyStore,
    options?: BuildKnowledgeCardsOptions
): Promise<KnowledgeCard[]> {
    const events = await store.getEvents({
        fileUri: options?.fileUri,
        since: options?.since,
    });

    const lifecycles = buildErrorLifecycles(events, {
        fileUri: options?.fileUri,
    });

    const allCards: KnowledgeCard[] = [];
    for (const event of events) {
        if (!isCompileError(event)) {
            continue;
        }
        const cards = generateKnowledgeCard(event, events, lifecycles, {
            maxConcreteExamples: options?.maxConcreteExamples,
        });
        allCards.push(...cards);
    }

    return mergeAndSortKnowledgeCards(allCards);
}
