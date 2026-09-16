import * as assert from 'assert';
import { describe, it } from 'mocha';
import { buildJourneyViewModel } from '../journey/journeyViewModel';
import { buildErrorLifecycles } from '../debug/errorLifecycle';
import { parseCompilerStderrFull } from '../error/templateBacktrace';
import type { CompileSuccessEvent, DebugEvent } from '../debug/types';

// Structured GCC-shaped fixture, not a copy of the student's stored history.
const diagnostics = [
    "C:/exercise/student.h:15:5: warning: 'Student::capacity_' will be initialized after [-Wreorder]",
    '   15 | int capacity_;',
    '      |     ^~~~~~~~~',
    "C:/exercise/student.h:14:5: warning:   'int Student::count_' [-Wreorder]",
    '   14 | int count_;',
    '      |     ^~~~~~',
    'C:/exercise/student.h:19:5: warning:   when initialized here [-Wreorder]',
    '   19 | Student() : capacity_(2), count_(0) {}',
    '      | ^~~~~~~',
    "C:/exercise/base.h:20:10: warning: 'virtual void Base::show() const' was hidden [-Woverloaded-virtual=]",
    '   20 | virtual void show() const;',
    '      |              ^~~~',
    "C:/exercise/student.h:30:10: note:   by 'void Student::show(int)'",
].join('\n');

function compiled(id: number, stderr = diagnostics, complete = true): CompileSuccessEvent {
    return { id: `integration-${id}`, type: 'compile_success', timestamp: id * 10000,
        sessionId: 'integration', workspaceId: 'integration', fileUri: 'C:/exercise/main.cpp',
        parsedErrors: parseCompilerStderrFull(stderr), stderr, diagnosticsComplete: complete,
        exitCode: 0, durationMs: 1 };
}

function assertTwoLogicalWarnings(events: DebugEvent[]): void {
    const view = buildJourneyViewModel(events);
    assert.strictEqual(view.episodes.length, 2, 'one reorder + one hidden virtual warning');
    assert.strictEqual(buildErrorLifecycles(events).length, 2, 'shared lifecycle projection also groups');
    const details = view.episodes.map(episode =>
        (episode as typeof episode & { diagnosticDetails?: unknown[] }).diagnosticDetails?.length).sort();
    assert.deepStrictEqual(details, [2, 3], 'hidden/by and complete reorder evidence are retained');
}

describe('Warning grouping, successful observations and recurrence integration', () => {
    it('groups complete GCC warnings across repeated successful compiles without rewriting events', () => {
        const events = [compiled(1), compiled(2), compiled(3)];
        const before = JSON.stringify(events);
        assertTwoLogicalWarnings(events);
        const view = buildJourneyViewModel(events);
        assert.ok(view.episodes.every(e => !e.resolved && e.entries.length === 3));
        assert.strictEqual(JSON.stringify(events), before);
    });

    it('resolves logical warnings on complete absence and keeps a real recurrence separate', () => {
        const events = [compiled(1), compiled(2), compiled(3, ''), compiled(4), compiled(5)];
        const view = buildJourneyViewModel(events);
        assert.strictEqual(view.episodes.length, 4, 'two warning kinds, each with fixed and recurring journeys');
        assert.strictEqual(view.episodes.filter(e => e.resolved && e.resolvedAt === 30000).length, 2);
        assert.strictEqual(view.episodes.filter(e => !e.resolved && e.firstSeenAt === 40000).length, 2);
    });

    it('keeps grouping and continuity through incremental make and legacy unknown success', () => {
        const legacy = compiled(3, '');
        delete legacy.parsedErrors;
        delete legacy.diagnosticsComplete;
        delete legacy.stderr;
        const events = [compiled(1), compiled(2, '', false), legacy, compiled(4, diagnostics, false)];
        assertTwoLogicalWarnings(events);
        assert.ok(buildJourneyViewModel(events).episodes.every(e => !e.resolved && e.entries.length === 4));
    });

    it('does not split old parameterized-code records from newly parsed observations', () => {
        const legacy = compiled(1);
        const hidden = legacy.parsedErrors!.find(p => p.raw.includes('was hidden'))!;
        // Before parameter-code parsing, the suffix stayed inside message and code was absent.
        hidden.message = "'virtual void Base::show() const' was hidden [-Woverloaded-virtual=]";
        delete hidden.code;
        legacy.fingerprint = 'old-fingerprint-kept-verbatim';
        const modern = compiled(2, diagnostics.replace('[-Woverloaded-virtual=]', '[-Woverloaded-virtual=1]'));
        const before = JSON.stringify(legacy);
        assertTwoLogicalWarnings([legacy, modern]);
        assert.strictEqual(JSON.stringify(legacy), before);
        assert.ok(buildJourneyViewModel([legacy, modern]).episodes.every(e => !e.resolved));
    });
});
