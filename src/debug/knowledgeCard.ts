import type { ParsedError } from '../error/errorParser';
import { getKnowledgeConcept, matchErrorToKnowledge } from '../error/errorKnowledgeMap';
import { createErrorSignature, signatureKey, signaturesMatch } from './errorFingerprint';
import type { ErrorLifecycle } from './errorLifecycle';
import { findFixingEdits } from './errorLifecycle';
import { formatFixAsDiff, normalizeCodeForDiff } from './formatDiff';
import type { CompileErrorEvent, DebugEvent } from './types';

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
        });
    }

    return cards;
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
