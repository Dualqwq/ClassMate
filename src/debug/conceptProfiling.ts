import type { DebugEvent } from './types';
import { isCompileError } from './types';
import { matchErrorToKnowledge } from '../error/errorKnowledgeMap';
import type { ErrorLifecycle } from './errorLifecycle';

export interface ConceptProfile {
    tag: string;
    occurrenceCount: number;
    resolvedCount: number;
    unresolvedCount: number;
    avgFixAttempts: number;
    lastSeenAt: number;
}

export function buildConceptProfile(
    events: DebugEvent[],
    lifecycles: ErrorLifecycle[]
): ConceptProfile[] {
    const profiles = new Map<string, ConceptProfile>();

    for (const event of events) {
        if (!isCompileError(event)) {
            continue;
        }

        const seenTags = new Set<string>();
        for (const parsed of event.parsedErrors) {
            const matches = matchErrorToKnowledge(parsed.message);
            for (const match of matches) {
                if (seenTags.has(match.tag)) {
                    continue;
                }
                seenTags.add(match.tag);

                let profile = profiles.get(match.tag);
                if (!profile) {
                    profile = {
                        tag: match.tag,
                        occurrenceCount: 0,
                        resolvedCount: 0,
                        unresolvedCount: 0,
                        avgFixAttempts: 0,
                        lastSeenAt: 0,
                    };
                    profiles.set(match.tag, profile);
                }

                profile.occurrenceCount += 1;
                profile.lastSeenAt = Math.max(profile.lastSeenAt, event.timestamp);
            }
        }
    }

    // Map each lifecycle to its concept tags and update resolved/unresolved/fix attempts.
    for (const lifecycle of lifecycles) {
        for (const tag of lifecycle.signature.knowledgeTags) {
            const profile = profiles.get(tag);
            if (!profile) {
                continue;
            }

            if (lifecycle.resolvedAt) {
                profile.resolvedCount += 1;
            } else {
                profile.unresolvedCount += 1;
            }

            // Accumulate attempts; we'll average per occurrence later.
            profile.avgFixAttempts += lifecycle.attemptsBeforeResolve;
        }
    }

    for (const profile of profiles.values()) {
        const total = profile.resolvedCount + profile.unresolvedCount;
        profile.avgFixAttempts = total > 0 ? profile.avgFixAttempts / total : 0;
    }

    return [...profiles.values()].sort((a, b) => {
        if (b.unresolvedCount !== a.unresolvedCount) {
            return b.unresolvedCount - a.unresolvedCount;
        }
        if (b.occurrenceCount !== a.occurrenceCount) {
            return b.occurrenceCount - a.occurrenceCount;
        }
        if (b.avgFixAttempts !== a.avgFixAttempts) {
            return b.avgFixAttempts - a.avgFixAttempts;
        }
        return b.lastSeenAt - a.lastSeenAt;
    });
}
