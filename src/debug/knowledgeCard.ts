import type { ParsedError } from '../error/errorParser';
import { getKnowledgeConcept, matchErrorToKnowledge } from '../error/errorKnowledgeMap';
import { createErrorSignature, signatureKey, signaturesMatch } from './errorFingerprint';
import type { ErrorLifecycle } from './errorLifecycle';
import { findFixingEdits } from './errorLifecycle';
import type { CompileErrorEvent, DebugEvent } from './types';

const DEFAULT_MAX_CONCRETE_EXAMPLES = 3;

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
    concreteCorrectExamples: string[];
}

export interface GenerateCardOptions {
    maxConcreteExamples?: number;
}

function normalizeExample(value: string): string {
    return value
        .replace(/\r\n/g, '\n')
        .replace(/[ \t]+/g, ' ')
        .trim()
        .toLowerCase();
}

function collectConcreteExamples(
    editIds: string[],
    allEvents: DebugEvent[],
    maxExamples: number
): string[] {
    const examples: string[] = [];
    const seen = new Set<string>();

    for (const editId of editIds) {
        if (examples.length >= maxExamples) {
            break;
        }
        const edit = allEvents.find((e) => e.id === editId && e.type === 'code_modified');
        if (!edit || edit.type !== 'code_modified') {
            continue;
        }
        const after = edit.after.trim();
        if (!after) {
            continue;
        }
        const normalized = normalizeExample(after);
        if (seen.has(normalized)) {
            continue;
        }
        seen.add(normalized);
        examples.push(after);
    }

    return examples;
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
        const matches = matchErrorToKnowledge(parsed.message);
        const bestMatch = matches.find((m) => getKnowledgeConcept(m.tag) !== undefined);
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

        const concreteExamples = collectConcreteExamples(editIds, allEvents, maxConcreteExamples);

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
            concreteCorrectExamples: concreteExamples,
        });
    }

    return cards;
}

/**
 * Merge knowledge cards that share the same tag, accumulating statistics and
 * deduplicating source events, edits, and concrete examples.
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
        let frequency = 0;
        let resolvedCount = 0;
        let unresolvedCount = 0;
        let weightedAttempts = 0;
        let lastSeenAt = 0;
        const sourceEvents = new Set<string>();
        const correctingEditIds = new Set<string>();
        const concreteExamples: string[] = [];
        const seenExamples = new Set<string>();

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
            for (const example of card.concreteCorrectExamples) {
                const normalized = normalizeExample(example);
                if (!seenExamples.has(normalized)) {
                    seenExamples.add(normalized);
                    concreteExamples.push(example);
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
            concreteCorrectExamples: concreteExamples,
        });
    }

    return merged;
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
            if (matches.some((m) => m.tag === card.tag)) {
                return parsed;
            }
        }
    }
    return undefined;
}
