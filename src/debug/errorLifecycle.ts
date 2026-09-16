import { buildWarningLifecycles, warningIdentity, type WarningJourney } from './warningLifecycle';
import type { ParsedError } from '../error/errorParser';
import type {
    CodeModifiedEvent,
    CompileDiagnosticEvent,
    CompileErrorEvent,
    CompileSuccessEvent,
    DebugEvent,
} from './types';
import { hasCompileDiagnostics, isCodeModified, isCompileError, isCompileSuccess } from './types';
import { createErrorSignature, type ErrorSignature, signaturesMatch, type MatchOptions } from './errorFingerprint';

export interface ErrorLifecycle {
    errorEventId: string;
    signature: ErrorSignature;
    firstSeenAt: number;
    resolvedAt?: number;
    resolvingEditId?: string;
    attemptsBeforeResolve: number;
    subsequentCompilesChecked: number;
    warning?: WarningJourney;
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
    errorEvent: CompileDiagnosticEvent,
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

    if (targetSignatures.some(target => target.severity === 'warning')) {
        const keys = new Set(errorEvent.parsedErrors.filter(p => p.severity === 'warning' &&
            targetSignatures.some(target => signaturesMatch(target, createErrorSignature(p), matchOptions)))
            .map(p => warningIdentity(errorEvent, p)));
        const records = buildWarningLifecycles([errorEvent, ...subsequentEvents.filter(e =>
            e.id !== errorEvent.id && e.timestamp > errorEvent.timestamp)], fileUri)
            .filter(l => l.errorEventId === errorEvent.id && l.warning && keys.has(l.warning.key));
        const outcomes: { resolved: boolean; resolvedAt?: number; resolvingEditId?: string; attempts: number }[] = records.map(l => ({ resolved: l.resolvedAt !== undefined, resolvedAt: l.resolvedAt,
            resolvingEditId: l.resolvingEditId, attempts: l.attemptsBeforeResolve }));
        outcomes.push(...targetSignatures.filter(target => target.severity !== 'warning').map(target =>
            isErrorResolved(errorEvent, subsequentEvents, { ...options, targetSignature: target })));
        const latest = [...outcomes].sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0))[0];
        const resolved = outcomes.length > 0 && outcomes.every(o => o.resolved);
        return { resolved, resolvedAt: resolved ? latest?.resolvedAt : undefined,
            resolvingEditId: resolved ? latest?.resolvingEditId : undefined,
            attempts: Math.max(0, ...outcomes.map(o => o.attempts)) };
    }

    const laterEvents = subsequentEvents.filter((e) => e.timestamp > errorEvent.timestamp);
    const compileEvents = filterCompileEvents(laterEvents, fileUri);

    let attempts = 0;
    let observedCompiles = 0;
    let lastCodeModified: CodeModifiedEvent | undefined;

    for (const event of compileEvents) {
        if (observedCompiles >= lookAhead) { break; }
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

        attempts += 1;
        const successful = isCompileSuccess(event);
        const warningTargets = targetSignatures.filter(target => target.severity === 'warning');
        if (successful && (event.parsedErrors === undefined || event.diagnosticsComplete === false) && warningTargets.length > 0) {
            // Legacy/partial success does not prove an absent warning is gone.
            // Unknown observations do not consume the diagnostic look-ahead budget.
            continue;
        }
        observedCompiles += 1;
        const currentSignatures = (event.parsedErrors ?? [])
            .filter(p => p.severity === 'error' || p.severity === 'warning')
            .map(p => createErrorSignature(p, { includeCode: false, includeFile: false }));
        const stillPresent = targetSignatures.some(target =>
            // Successful compilation resolves errors even if a same-message warning remains.
            (!successful || target.severity === 'warning') &&
            currentSignatures.some(current =>
                (!successful || current.severity === 'warning') && signaturesMatch(target, current, matchOptions))
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
 * Build lifecycles for errors/warnings in failed builds and warnings in successful builds.
 */
export function buildErrorLifecycles(
    events: DebugEvent[],
    options: ResolutionOptions = {}
): ErrorLifecycle[] {
    const lifecycles: ErrorLifecycle[] = [];

    for (const event of events) {
        if (!hasCompileDiagnostics(event)) {
            continue;
        }

        const fileUri = options.fileUri ?? event.fileUri;
        if (fileUri && event.fileUri !== fileUri) {
            continue;
        }

        for (const parsed of event.parsedErrors) {
            if (parsed.severity !== 'error' || isCompileSuccess(event)) {
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

    // Preserve the original event/diagnostic order for equal-time timeline cards.
    const eventOrder = new Map(events.map((event, index) => [event.id, index]));
    const diagnosticOrder = (lifecycle: ErrorLifecycle): number => {
        const event = events[eventOrder.get(lifecycle.errorEventId) ?? -1];
        if (!event || !hasCompileDiagnostics(event)) { return 0; }
        return event.parsedErrors.findIndex(parsed => lifecycle.warning
            ? parsed.severity === 'warning' && warningIdentity(event, parsed) === lifecycle.warning.key
            : parsed.severity === 'error' && signaturesMatch(lifecycle.signature, createErrorSignature(parsed), { mode: 'fuzzy' }));
    };
    return [...lifecycles, ...buildWarningLifecycles(events, options.fileUri)].sort((a, b) =>
        (eventOrder.get(a.errorEventId) ?? 0) - (eventOrder.get(b.errorEventId) ?? 0) ||
        diagnosticOrder(a) - diagnosticOrder(b));
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
    errorEvent: CompileDiagnosticEvent,
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
 * observation. Unresolved signatures are included with `edit: undefined`.
 */
export function findFixingEdits(
    errorEvent: CompileDiagnosticEvent,
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
