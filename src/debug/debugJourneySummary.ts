import type { DebugJourneyStore } from './debugJourneyStore';
import type {
    CompileErrorEvent,
    CodeModifiedEvent,
    DebugEvent,
    HintRequestedEvent,
} from './types';
import { isCompileError, isCodeModified, isHintRequested } from './types';

export interface JourneySummary {
    workspaceId: string;
    fileUri?: string;
    totalEvents: number;
    compileErrors: CompileErrorEvent[];
    hintsRequested: HintRequestedEvent[];
    modifications: CodeModifiedEvent[];
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

    const compileErrors: CompileErrorEvent[] = [];
    const hintsRequested: HintRequestedEvent[] = [];
    const modifications: CodeModifiedEvent[] = [];

    for (const event of events) {
        if (isCompileError(event)) {
            compileErrors.push(event);
        } else if (isHintRequested(event)) {
            hintsRequested.push(event);
        } else if (isCodeModified(event)) {
            modifications.push(event);
        }
    }

    const suggestedSteps = generatePlaceholderSteps(events, compileErrors, hintsRequested);

    return {
        workspaceId: store.workspaceId,
        fileUri: options?.fileUri,
        totalEvents: events.length,
        compileErrors,
        hintsRequested,
        modifications,
        suggestedSteps,
    };
}

function generatePlaceholderSteps(
    allEvents: DebugEvent[],
    compileErrors: CompileErrorEvent[],
    hintsRequested: HintRequestedEvent[]
): string[] {
    const steps: string[] = [];

    if (allEvents.length === 0) {
        steps.push('No debug events recorded yet.');
        return steps;
    }

    steps.push(`Recorded ${allEvents.length} debug events in total.`);

    if (compileErrors.length > 0) {
        steps.push(`Encountered ${compileErrors.length} compile errors.`);
    }

    if (hintsRequested.length > 0) {
        steps.push(`Asked for hints ${hintsRequested.length} times.`);
    }

    const errorMessages = compileErrors
        .flatMap((e) => e.parsedErrors.map((p) => p.message))
        .filter(Boolean);
    const uniqueMessages = [...new Set(errorMessages)].slice(0, 3);
    for (const message of uniqueMessages) {
        steps.push(`Common error: ${message}`);
    }

    return steps;
}
