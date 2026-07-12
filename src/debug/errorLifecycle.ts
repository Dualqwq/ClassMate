import type { ParsedError } from '../error/errorParser';
import type {
    CodeModifiedEvent,
    CompileErrorEvent,
    CompileSuccessEvent,
    DebugEvent,
} from './types';
import { isCodeModified, isCompileError, isCompileSuccess } from './types';
import { createErrorSignature, type ErrorSignature, signaturesMatch, type MatchOptions } from './errorFingerprint';

export interface ErrorLifecycle {
    errorEventId: string;
    signature: ErrorSignature;
    firstSeenAt: number;
    resolvedAt?: number;
    resolvingEditId?: string;
    attemptsBeforeResolve: number;
    subsequentCompilesChecked: number;
}

export interface ResolutionOptions {
    lookAheadCompiles?: number;
    matchOptions?: MatchOptions;
    fileUri?: string;
    targetSignature?: ErrorSignature;
}

const DEFAULT_LOOK_AHEAD_COMPILES = 5;

type CompileOutcomeEvent = CompileErrorEvent | CompileSuccessEvent;

function filterCompileEvents(events: DebugEvent[], fileUri?: string): CompileOutcomeEvent[] {
    return events.filter(
        (e): e is CompileOutcomeEvent =>
            (isCompileError(e) || isCompileSuccess(e)) &&
            (!fileUri || e.fileUri === fileUri)
    );
}

/**
 * Determine whether a specific error observed in `errorEvent` is resolved
 * within the next N compile attempts.
 *
 * "Resolved" means the same error signature does not appear in any of the
 * following `lookAheadCompiles` compile events for the same file.
 */
export function isErrorResolved(
    errorEvent: CompileErrorEvent,
    subsequentEvents: DebugEvent[],
    options: ResolutionOptions = {}
): { resolved: boolean; resolvedAt?: number; resolvingEditId?: string; attempts: number } {
    const lookAhead = options.lookAheadCompiles ?? DEFAULT_LOOK_AHEAD_COMPILES;
    const matchOptions = options.matchOptions ?? { mode: 'fuzzy' };
    const fileUri = options.fileUri ?? errorEvent.fileUri;

    const targetSignatures: ErrorSignature[] = options.targetSignature
        ? [options.targetSignature]
        : errorEvent.parsedErrors
              .filter((p) => p.severity === 'error' || p.severity === 'warning')
              .map((p) => createErrorSignature(p, { includeCode: false, includeFile: false }));

    if (targetSignatures.length === 0) {
        return { resolved: true, attempts: 0 };
    }

    const laterEvents = subsequentEvents.filter((e) => e.timestamp > errorEvent.timestamp);
    const compileEvents = filterCompileEvents(laterEvents, fileUri).slice(0, lookAhead);

    let attempts = 0;
    let lastCodeModified: CodeModifiedEvent | undefined;

    for (const event of compileEvents) {
        // Track the most recent code modification before this compile event.
        const editsSinceLast = laterEvents.filter(
            (e): e is CodeModifiedEvent =>
                isCodeModified(e) &&
                e.timestamp > errorEvent.timestamp &&
                e.timestamp < event.timestamp &&
                (!fileUri || e.fileUri === fileUri)
        );
        if (editsSinceLast.length > 0) {
            lastCodeModified = editsSinceLast[editsSinceLast.length - 1];
        }

        if (isCompileSuccess(event)) {
            attempts += 1;
            // A successful compile resolves all outstanding errors.
            return {
                resolved: true,
                resolvedAt: event.timestamp,
                resolvingEditId: lastCodeModified?.id,
                attempts,
            };
        }

        attempts += 1;

        const currentSignatures: ErrorSignature[] = event.parsedErrors
            .filter((p) => p.severity === 'error' || p.severity === 'warning')
            .map((p) => createErrorSignature(p, { includeCode: false, includeFile: false }));

        const stillPresent = targetSignatures.some((target) =>
            currentSignatures.some((current) => signaturesMatch(target, current, matchOptions))
        );

        if (stillPresent) {
            continue;
        }

        // Error disappeared before next compile success; treat as resolved here.
        return {
            resolved: true,
            resolvedAt: event.timestamp,
            resolvingEditId: lastCodeModified?.id,
            attempts,
        };
    }

    return { resolved: false, attempts };
}

/**
 * Build a lifecycle record for every error-level diagnostic in compile_error events.
 */
export function buildErrorLifecycles(
    events: DebugEvent[],
    options: ResolutionOptions = {}
): ErrorLifecycle[] {
    const lifecycles: ErrorLifecycle[] = [];

    for (const event of events) {
        if (!isCompileError(event)) {
            continue;
        }

        const fileUri = options.fileUri ?? event.fileUri;
        if (fileUri && event.fileUri !== fileUri) {
            continue;
        }

        for (const parsed of event.parsedErrors) {
            if (parsed.severity !== 'error' && parsed.severity !== 'warning') {
                continue;
            }

            const signature = createErrorSignature(parsed, { includeCode: false, includeFile: false });
            const resolution = isErrorResolved(event, events, {
                ...options,
                fileUri,
                targetSignature: signature,
            });

            lifecycles.push({
                errorEventId: event.id,
                signature,
                firstSeenAt: event.timestamp,
                resolvedAt: resolution.resolved ? resolution.resolvedAt : undefined,
                resolvingEditId: resolution.resolvingEditId,
                attemptsBeforeResolve: resolution.attempts,
                subsequentCompilesChecked: resolution.attempts,
            });
        }
    }

    return lifecycles;
}

export interface FixingEditResult {
    signature: ErrorSignature;
    edit?: CodeModifiedEvent;
}

/**
 * Find the code modification that most likely fixed a specific error signature.
 *
 * The caller can pass any signature created from the same ParsedError; matching
 * is performed with `signaturesMatch` so the exact object identity does not
 * matter.
 */
export function findFixingEditForSignature(
    errorEvent: CompileErrorEvent,
    events: DebugEvent[],
    signature: ErrorSignature,
    options: ResolutionOptions = {}
): CodeModifiedEvent | undefined {
    const matchOptions = options.matchOptions ?? { mode: 'fuzzy' };

    // Locate the parsed error in the event that matches the caller's signature.
    const parsed = errorEvent.parsedErrors.find(
        (p) =>
            (p.severity === 'error' || p.severity === 'warning') &&
            signaturesMatch(
                signature,
                createErrorSignature(p, { includeCode: false, includeFile: false }),
                matchOptions
            )
    );

    if (!parsed) {
        return undefined;
    }

    const targetSignature = createErrorSignature(parsed, { includeCode: false, includeFile: false });
    const resolution = isErrorResolved(errorEvent, events, {
        ...options,
        targetSignature,
    });

    if (!resolution.resolved || !resolution.resolvingEditId) {
        return undefined;
    }

    return events.find(
        (e): e is CodeModifiedEvent =>
            isCodeModified(e) && e.id === resolution.resolvingEditId
    );
}

/**
 * Find the likely fixing edit for every error/warning signature in a compile
 * error event. Unresolved signatures are included with `edit: undefined`.
 */
export function findFixingEdits(
    errorEvent: CompileErrorEvent,
    events: DebugEvent[],
    options: ResolutionOptions = {}
): FixingEditResult[] {
    const signatures = errorEvent.parsedErrors
        .filter((p) => p.severity === 'error' || p.severity === 'warning')
        .map((p) => createErrorSignature(p, { includeCode: false, includeFile: false }));

    return signatures.map((signature) => ({
        signature,
        edit: findFixingEditForSignature(errorEvent, events, signature, options),
    }));
}
