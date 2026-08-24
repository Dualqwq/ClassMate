import * as assert from 'assert';
import { describe, it } from 'mocha';
import { formatDebugLog, formatRawDebugLog } from '../chat/debugLogFormatter';
import type { DebugEventIndex } from '../debug/debugJourneyStore';
import type { CompileErrorEvent, DebugEvent, HintRequestedEvent } from '../debug/types';

function makeIndex(total: number): DebugEventIndex {
    return {
        total,
        counts: {
            compile_error: 0,
            compile_success: 0,
            run_success: 0,
            run_error: 0,
            hint_requested: 0,
            code_modified: 0,
        },
    };
}

function makeCompileError(
    id: string,
    parsedErrors: CompileErrorEvent['parsedErrors'],
    stderr?: string
): CompileErrorEvent {
    return {
        id,
        type: 'compile_error',
        timestamp: 0,
        sessionId: 's1',
        workspaceId: 'ws',
        fileUri: 'file:///main.cpp',
        stderr: stderr ?? parsedErrors.map((p) => p.raw).join('\n'),
        parsedErrors,
        exitCode: 1,
        durationMs: 100,
    };
}

function makeHint(id: string, intent: string): HintRequestedEvent {
    return {
        id,
        type: 'hint_requested',
        timestamp: 0,
        sessionId: 's1',
        workspaceId: 'ws',
        intent: intent as HintRequestedEvent['intent'],
        userPrompt: '/hint',
    };
}

describe('debugLogFormatter', () => {
    it('summarizes compile_error diagnostics', () => {
        const event = makeCompileError('e1', [
            {
                raw: "main.cpp:5:10: error: expected ';' before 'return'",
                file: 'main.cpp',
                line: 5,
                column: 10,
                severity: 'error',
                message: "expected ';' before 'return'",
            },
            {
                raw: "main.cpp:8:5: warning: unused variable 'y' [-Wunused-variable]",
                file: 'main.cpp',
                line: 8,
                column: 5,
                severity: 'warning',
                message: "unused variable 'y'",
                code: '-Wunused-variable',
            },
        ]);

        const output = formatDebugLog([event], makeIndex(1), 'ws');
        assert.ok(output.includes('diagnostics: 2 total (1 error(s), 1 warning(s), 0 note(s))'));
        assert.ok(output.includes('[error] main.cpp:5:10: expected \';\' before \'return\''));
        assert.ok(output.includes('[warning] main.cpp:8:5: unused variable \'y\''));
    });

    it('falls back to stderr preview when parsedErrors is empty', () => {
        const event = makeCompileError('e1', [], 'fatal error: no input files');
        const output = formatDebugLog([event], makeIndex(1), 'ws');
        assert.ok(output.includes('stderr preview: fatal error: no input files'));
        assert.ok(!output.includes('diagnostics:'));
    });

    it('truncates long diagnostic lists', () => {
        const parsedErrors = Array.from({ length: 12 }, (_, i) => ({
            raw: `main.cpp:${i + 1}:1: error: error ${i + 1}`,
            file: 'main.cpp',
            line: i + 1,
            column: 1,
            severity: 'error' as const,
            message: `error ${i + 1}`,
        }));
        const event = makeCompileError('e1', parsedErrors);
        const output = formatDebugLog([event], makeIndex(1), 'ws');
        assert.ok(output.includes('diagnostics: 12 total (12 error(s), 0 warning(s), 0 note(s))'));
        assert.ok(output.includes('... and 4 more diagnostic(s)'));
        const matches = output.match(/\[error\] main\.cpp:/g);
        assert.strictEqual(matches?.length, 8);
    });

    it('keeps non-compile stderr preview for run_error events', () => {
        const event: DebugEvent = {
            id: 'r1',
            type: 'run_error',
            timestamp: 0,
            sessionId: 's1',
            workspaceId: 'ws',
            fileUri: 'file:///main.cpp',
            executablePath: 'C:\\main.exe',
            stderr: 'Segmentation fault\nmore details',
            exitCode: 139,
            durationMs: 50,
            kind: 'runtime_segmentation_fault',
        };
        const output = formatDebugLog([event], makeIndex(1), 'ws');
        assert.ok(output.includes('stderr preview: Segmentation fault'));
    });

    it('renders hint_requested intent', () => {
        const event = makeHint('h1', 'hint');
        const output = formatDebugLog([event], makeIndex(1), 'ws');
        assert.ok(output.includes('intent: hint'));
    });

    it('renders raw log as JSON lines', () => {
        const event = makeCompileError('e1', [
            {
                raw: 'main.cpp:1:1: error: x',
                file: 'main.cpp',
                line: 1,
                column: 1,
                severity: 'error',
                message: 'x',
            },
        ]);
        const output = formatRawDebugLog([event], makeIndex(1), 'ws');
        assert.ok(output.includes('=== DEBUG: raw implicit log ==='));
        assert.ok(output.includes('"type":"compile_error"'));
        assert.ok(output.includes('"parsedErrors"'));
    });
});
