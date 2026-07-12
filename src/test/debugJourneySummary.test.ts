import * as assert from 'assert';
import { describe, it } from 'mocha';
import { buildJourneySummary } from '../debug/debugJourneySummary';
import type { DebugJourneyStore } from '../debug/debugJourneyStore';
import type { CompileErrorEvent, CompileSuccessEvent, DebugEvent } from '../debug/types';

function createStubStore(events: DebugEvent[]): DebugJourneyStore {
    return {
        workspaceId: 'test-ws',
        getEvents: async () => events,
        getIndex: async () => ({
            total: events.length,
            counts: {
                compile_error: events.filter((e) => e.type === 'compile_error').length,
                compile_success: events.filter((e) => e.type === 'compile_success').length,
                run_error: 0,
                hint_requested: 0,
                code_modified: 0,
            },
        }),
        append: async () => {},
        appendMany: async () => {},
        getLastEvent: async () => undefined,
        clear: async () => {},
    } as unknown as DebugJourneyStore;
}

function compileError(id: string, timestamp: number, messages: string[]): CompileErrorEvent {
    return {
        id,
        type: 'compile_error',
        timestamp,
        sessionId: 'session-1',
        workspaceId: 'test-ws',
        fileUri: 'file:///main.cpp',
        stderr: messages.join('\n'),
        parsedErrors: messages.map((message) => ({
            raw: message,
            severity: 'error' as const,
            message,
        })),
        exitCode: 1,
        durationMs: 100,
    };
}

function compileSuccess(id: string, timestamp: number): CompileSuccessEvent {
    return {
        id,
        type: 'compile_success',
        timestamp,
        sessionId: 'session-1',
        workspaceId: 'test-ws',
        fileUri: 'file:///main.cpp',
        exitCode: 0,
        durationMs: 100,
    };
}

describe('Debug Journey Summary', () => {
    it('produces a summary with resolved errors', async () => {
        const events: DebugEvent[] = [
            compileError('e1', 1, ["'x' was not declared in this scope"]),
            compileSuccess('s1', 2),
        ];
        const store = createStubStore(events);

        const summary = await buildJourneySummary(store);
        assert.strictEqual(summary.totalEvents, 2);
        assert.strictEqual(summary.errorStats.totalCompileErrors, 1);
        assert.strictEqual(summary.errorStats.totalCompileSuccesses, 1);
        assert.strictEqual(summary.lifecycles.length, 1);
        assert.ok(summary.lifecycles[0].resolvedAt);
        assert.strictEqual(summary.suggestedSteps.length > 0, true);
    });

    it('identifies top concept profile', async () => {
        const events: DebugEvent[] = [
            compileError('e1', 1, ["'x' was not declared in this scope"]),
            compileError('e2', 2, ["expected ';' at end of declaration"]),
            compileSuccess('s1', 3),
        ];
        const store = createStubStore(events);

        const summary = await buildJourneySummary(store);
        assert.strictEqual(summary.conceptProfiles.length >= 2, true);
        const undeclared = summary.conceptProfiles.find((p) => p.tag === 'undeclared_identifier');
        const missingSemicolon = summary.conceptProfiles.find((p) => p.tag === 'missing_semicolon');
        assert.ok(undeclared);
        assert.ok(missingSemicolon);
    });
});
