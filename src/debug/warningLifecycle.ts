import type { ParsedError } from '../error/errorParser';
import { createErrorSignature, normalizeErrorMessage } from './errorFingerprint';
import type { ErrorLifecycle } from './errorLifecycle';
import { normalizeFilePath } from './fileIdentity';
import { hasCompileDiagnostics, isCodeModified, isCompileError, isCompileSuccess, type CompileDiagnosticEvent, type DebugEvent } from './types';

export interface WarningLocation {
    fileUri?: string;
    line?: number;
    column?: number;
}

export interface WarningJourney {
    key: string;
    eventIds: string[];
    lastSeenAt: number;
    diagnostic: ParsedError;
    /** All locations in the most recent observation, not a claim about current source. */
    locations: WarningLocation[];
}

function canonicalPath(file: string): string {
    const path = normalizeFilePath(file);
    return /^[a-z]:\//i.test(path) || path.startsWith('//') ? path.toLowerCase() : path;
}

function targetKey(event: DebugEvent): string {
    // Missing target identity is insufficient evidence for cross-event merging.
    return event.fileUri ? canonicalPath(event.fileUri) : `unknown:${event.id}`;
}

export function sameWarningTarget(a: DebugEvent, b: DebugEvent): boolean {
    return targetKey(a) === targetKey(b);
}

/** Same fuzzy message semantics as errors, but never across diagnostic files or warning families. */
export function warningIdentity(event: CompileDiagnosticEvent, parsed: ParsedError): string {
    const suffix = /\s*\[(-W[-\w=]+(?:,\s*-W[-\w=]+)*)\]\s*$/.exec(parsed.message);
    const code = parsed.code ?? suffix?.[1].split(/,\s*/).find(c => c !== '-Werror') ?? '';
    const message = suffix ? parsed.message.slice(0, suffix.index) : parsed.message;
    let file = parsed.file ? canonicalPath(parsed.file) : targetKey(event);
    // A bare diagnostic for the target itself has an unambiguous absolute equivalent.
    if (event.fileUri && !file.includes('/') && canonicalPath(event.fileUri).split('/').at(-1) === file) {
        file = canonicalPath(event.fileUri);
    }
    return JSON.stringify([targetKey(event), file, normalizeErrorMessage(message), code.split('=')[0]]);
}

function locations(diagnostics: ParsedError[]): WarningLocation[] {
    const unique = new Map<string, WarningLocation>();
    for (const p of diagnostics) {
        const key = JSON.stringify([p.file ? canonicalPath(p.file) : '', p.line, p.column]);
        unique.set(key, { fileUri: p.file, line: p.line, column: p.column });
    }
    return [...unique.values()];
}

/**
 * One lifecycle per continuous warning, independent of how many builds re-observe it.
 * A reliable absence closes a lifecycle; recurrence afterwards starts a new one.
 * Error lifecycles retain their existing event-based policy in errorLifecycle.ts.
 */
export function buildWarningLifecycles(events: DebugEvent[], fileUri?: string): ErrorLifecycle[] {
    const result: ErrorLifecycle[] = [];
    const active = new Map<string, { lifecycle: ErrorLifecycle; target: string }>();
    const latestEdits = new Map<string, { id: string; timestamp: number }>();
    for (const event of [...events].sort((a, b) => a.timestamp - b.timestamp)) {
        if (fileUri && targetKey(event) !== canonicalPath(fileUri)) { continue; }
        const target = targetKey(event);
        if (isCodeModified(event)) {
            latestEdits.set(target, { id: event.id, timestamp: event.timestamp });
            continue;
        }
        if (!isCompileError(event) && !isCompileSuccess(event)) { continue; }
        const observed = new Map<string, ParsedError[]>();
        if (hasCompileDiagnostics(event)) {
            for (const parsed of event.parsedErrors) {
                if (parsed.severity !== 'warning') { continue; }
                const key = warningIdentity(event, parsed);
                const group = observed.get(key) ?? [];
                group.push(parsed);
                observed.set(key, group);
            }
        }
        const complete = isCompileError(event) ||
            (event.parsedErrors !== undefined && event.diagnosticsComplete !== false);
        for (const [key, state] of active) {
            if (state.target !== target) { continue; }
            const lifecycle = state.lifecycle;
            lifecycle.attemptsBeforeResolve += 1;
            lifecycle.subsequentCompilesChecked += 1;
            if (!observed.has(key) && complete) {
                lifecycle.resolvedAt = event.timestamp;
                const edit = latestEdits.get(target);
                if (edit && edit.timestamp > lifecycle.firstSeenAt) { lifecycle.resolvingEditId = edit.id; }
                active.delete(key);
            }
        }
        for (const [key, diagnostics] of observed) {
            const parsed = diagnostics[0];
            const existing = active.get(key)?.lifecycle;
            if (existing?.warning) {
                existing.warning.eventIds.push(event.id);
                existing.warning.lastSeenAt = event.timestamp;
                existing.warning.diagnostic = parsed;
                existing.warning.locations = locations(diagnostics);
                continue;
            }
            const lifecycle: ErrorLifecycle = {
                errorEventId: event.id,
                signature: createErrorSignature(parsed, { includeCode: false, includeFile: false }),
                firstSeenAt: event.timestamp,
                attemptsBeforeResolve: 0,
                subsequentCompilesChecked: 0,
                warning: { key, eventIds: [event.id], lastSeenAt: event.timestamp,
                    diagnostic: parsed, locations: locations(diagnostics) },
            };
            result.push(lifecycle);
            active.set(key, { lifecycle, target });
        }
    }
    return result;
}
