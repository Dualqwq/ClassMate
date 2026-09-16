import { createCompileOutcome } from '../debug/compileOutcome';
import { hasCompileDiagnostics, type CodeModifiedEvent, type RunErrorEvent } from '../debug/types';
import { buildErrorLifecycles } from '../debug/errorLifecycle';
import { buildJourneyDigest } from '../chat/journeyDigestBuilder';
import { aggregateErrorStats } from '../debug/analytics';
import { buildNotebookInput } from '../debug/debugNotebook';
import type { DebugJourneyStore } from '../debug/debugJourneyStore';
import * as assert from 'assert';
import { describe, it } from 'mocha';
import { isErrorResolved } from '../debug/errorLifecycle';
import { buildJourneyViewModel } from '../journey/journeyViewModel';
import { parseCompilerStderrFull } from '../error/templateBacktrace';
import { computeEventFingerprint } from '../debug/eventEnvelope';
import type { CompileErrorEvent, CompileSuccessEvent } from '../debug/types';

const warning = 'main.cpp:3:9: warning: unused variable x [-Wunused-variable]';
const failed: CompileErrorEvent = { id: 'failed', type: 'compile_error', timestamp: 1000,
    sessionId: 's', workspaceId: 'w', fileUri: 'main.cpp', stderr: warning,
    parsedErrors: parseCompilerStderrFull(warning), exitCode: 1, durationMs: 2 };
const legacy: CompileSuccessEvent = { id: 'ok', type: 'compile_success', timestamp: 10000,
    sessionId: 's', workspaceId: 'w', fileUri: 'main.cpp', exitCode: 0, durationMs: 2 };
const stillWarns = { ...legacy, stderr: warning, parsedErrors: parseCompilerStderrFull(warning) };
const clean = { ...legacy, id: 'clean', timestamp: 20000, stderr: '', parsedErrors: [] };

describe('Successful compile warning evidence', () => {
    it('does not resolve a warning still present after successful compilation', () => {
        assert.strictEqual(isErrorResolved(failed, [stillWarns]).resolved, false);
    });
    it('resolves a warning only when a later compile explicitly reports no warning', () => {
        const result = isErrorResolved(failed, [stillWarns, clean]);
        assert.strictEqual(result.resolvedAt, clean.timestamp);
    });
    it('does not treat legacy success without diagnostics as proof a warning disappeared', () => {
        assert.strictEqual(isErrorResolved(failed, [legacy]).resolved, false);
    });
    it('shows warnings first observed during successful compilation without calling it a failure', () => {
        const view = buildJourneyViewModel([stillWarns]);
        assert.strictEqual(view.episodes.length, 1);
        assert.strictEqual(view.episodes[0].severity, 'warning');
        assert.strictEqual(view.episodes[0].resolved, false);
        assert.ok(view.episodes[0].entries[0].label.includes('编译成功'));
    });
    it('does not deduplicate a changed successful warning observation as the same event', () => {
        assert.notStrictEqual(computeEventFingerprint(stillWarns), computeEventFingerprint(clean));
        assert.notStrictEqual(computeEventFingerprint(legacy), computeEventFingerprint(clean));
    });
    it('keeps error and warning lifecycles separate for identical messages and positions', () => {
        const mixed = { ...failed, parsedErrors: [failed.parsedErrors[0], { ...failed.parsedErrors[0], severity: 'error' as const }] };
        const episodes = buildJourneyViewModel([mixed, stillWarns]).episodes.filter(e => e.errorEventId === failed.id);
        assert.strictEqual(episodes.length, 2);
        assert.strictEqual(episodes.find(e => e.severity === 'error')?.resolved, true);
        assert.strictEqual(episodes.find(e => e.severity === 'warning')?.resolved, false);
        const legacyEpisodes = buildJourneyViewModel([mixed, legacy]).episodes;
        assert.strictEqual(legacyEpisodes.find(e => e.severity === 'error')?.resolved, true);
        assert.strictEqual(legacyEpisodes.find(e => e.severity === 'warning')?.resolved, false);
    });
    it('continues past unknown historical observations to a complete compile', () => {
        const unknowns = Array.from({ length: 7 }, (_, i) => ({ ...legacy, id: `old-${i}`, timestamp: 2000 + i * 1000 }));
        const result = isErrorResolved(failed, [...unknowns, clean]);
        assert.strictEqual(result.resolvedAt, clean.timestamp);
        assert.strictEqual(result.attempts, 8);
    });
    it('does not resolve warnings from another compilation target', () => {
        assert.strictEqual(isErrorResolved(failed, [{ ...clean, fileUri: 'other.cpp' }]).resolved, false);
    });
    it('does not interpret incremental make no-op or partial rebuild as absence evidence', () => {
        const noOp = createCompileOutcome(legacy, { exitCode: 0, stderr: '', durationMs: 1 }, undefined, false);
        const partial = createCompileOutcome(legacy, { exitCode: 0, stderr: warning.replace('unused variable x', 'unused variable y'), durationMs: 1 }, undefined, false);
        assert.strictEqual(isErrorResolved(failed, [noOp, partial]).resolved, false);
        assert.strictEqual(buildJourneyViewModel([partial]).episodes[0].severity, 'warning');
        const view = buildJourneyViewModel([failed, noOp]);
        assert.ok(view.episodes[0].entries.some(entry => entry.label.includes('警告状态未完整核验')));
        assert.strictEqual(isErrorResolved(failed, [noOp, clean]).resolvedAt, clean.timestamp);
    });
    it('includes diagnostic coverage in success fingerprints while preserving the exact old hash', () => {
        assert.notStrictEqual(computeEventFingerprint({ ...clean, diagnosticsComplete: false }), computeEventFingerprint({ ...clean, diagnosticsComplete: true }));
        assert.strictEqual(computeEventFingerprint(legacy), '5cbc45cc03b66ff1b59a6c3aaebef4d045935aa7');
    });
    it('retains distinct warning snapshots inside the short deduplication window', () => {
        const a = { ...stillWarns, timestamp: 1000 };
        const b = { ...stillWarns, id: 'b', timestamp: 1001, parsedErrors: parseCompilerStderrFull(warning.replace('unused variable x', 'unused variable y')) };
        const view = buildJourneyViewModel([a, b]);
        assert.strictEqual(view.metrics.totalEvents, 2);
        assert.strictEqual(view.episodes.length, 2);
    });
    it('records explicit diagnostics for both successful and failed build results', () => {
        const output = `In file included from main.cpp:1:\nheader.h:3:2: warning: possible loss of data [-Wconversion]`;
        const ok = createCompileOutcome(legacy, { exitCode: 0, stderr: output, durationMs: 20 });
        assert.ok(hasCompileDiagnostics(ok));
        assert.strictEqual(ok.type, 'compile_success');
        assert.strictEqual(ok.stderr, output);
        assert.deepStrictEqual(ok.parsedErrors[1].viaIncludes, ['main.cpp:1']);
        const empty = createCompileOutcome(legacy, { exitCode: 0, stderr: '', durationMs: 20 });
        assert.ok(hasCompileDiagnostics(empty));
        assert.deepStrictEqual(empty.parsedErrors, []);
        const error = createCompileOutcome(legacy, { exitCode: 1, stderr: output, durationMs: 20 });
        assert.strictEqual(error.type, 'compile_error');
        assert.deepStrictEqual(error.parsedErrors, ok.parsedErrors);
    });
    it('includes successful warnings in the digest and counts a successful build as success', () => {
        const digest = buildJourneyDigest([stillWarns], { nowMs: 20000 });
        assert.ok(digest.includes('unused variable x'));
        assert.ok(digest.includes('编译警告'));
        assert.strictEqual(buildJourneyDigest([stillWarns, clean], { nowMs: 30000 }), '');
        const stats = aggregateErrorStats([stillWarns]);
        assert.strictEqual(stats.totalCompileErrors, 0);
        assert.strictEqual(stats.totalCompileSuccesses, 1);
        assert.strictEqual(stats.bySeverity.warning, 1);
    });
    it('attributes an edit after a success warning without requiring a related error event id', async () => {
        const source = createCompileOutcome(legacy, { exitCode: 0, stderr: 'main.cpp:3:2: warning: possible loss of data [-Wconversion]', durationMs: 1 });
        assert.ok(hasCompileDiagnostics(source));
        const edit: CodeModifiedEvent = { id: 'edit', type: 'code_modified', timestamp: 15000,
            sessionId: 's', workspaceId: 'w', fileUri: 'main.cpp', before: 'short x = 123456;',
            after: 'int x = 123456;', diff: '- short\n+ int', trigger: 'pre_compile' };
        const events = [source, edit, clean];
        const lifecycle = buildErrorLifecycles(events)[0];
        assert.strictEqual(lifecycle.resolvingEditId, edit.id);
        assert.strictEqual(lifecycle.resolvedAt, clean.timestamp);
        const store = { workspaceId: 'w', getEvents: async () => events, getResolvedMarks: async () => ({}) } as unknown as DebugJourneyStore;
        const notebook = await buildNotebookInput(store);
        assert.strictEqual(notebook.cards[0].tag, 'type_conversion');
        assert.strictEqual(notebook.cards[0].resolvedCount, 1);
        assert.deepStrictEqual(notebook.cards[0].correctingEditIds, [edit.id]);
        assert.strictEqual(notebook.cards[0].concreteFixes[0].after, edit.after);
    });
    it('never resolves an existing run error just because compilation succeeds', () => {
        const run: RunErrorEvent = { id: 'run', type: 'run_error', timestamp: 900,
            sessionId: 's', workspaceId: 'w', fileUri: 'main.exe', executablePath: 'main.exe',
            exitCode: 1, durationMs: 1, kind: 'runtime_unknown' };
        assert.strictEqual(buildJourneyViewModel([run, clean]).episodes.find(e => e.errorEventId === 'run')?.resolved, false);
    });

});
