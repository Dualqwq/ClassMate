import * as assert from 'assert';
import { describe, it } from 'mocha';
import {
    aggregateErrorStats,
    aggregateHintStats,
    aggregateSessionStats,
    aggregateTimeStats,
    computeDebugMetrics,
} from '../debug/analytics';
import type { CompileErrorEvent, CompileSuccessEvent, DebugEvent, HintRequestedEvent } from '../debug/types';

function compileError(id: string, timestamp: number, messages: string[]): CompileErrorEvent {
    return {
        id,
        type: 'compile_error',
        timestamp,
        sessionId: 'session-1',
        workspaceId: 'ws',
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
        workspaceId: 'ws',
        fileUri: 'file:///main.cpp',
        exitCode: 0,
        durationMs: 150,
    };
}

function hint(id: string, timestamp: number, intent: HintRequestedEvent['intent']): HintRequestedEvent {
    return {
        id,
        type: 'hint_requested',
        timestamp,
        sessionId: 'session-1',
        workspaceId: 'ws',
        fileUri: 'file:///main.cpp',
        intent,
        userPrompt: 'help',
    };
}

describe('Analytics', () => {
    it('aggregates error statistics', () => {
        const events: DebugEvent[] = [
            compileError('e1', 1, ["'x' was not declared in this scope"]),
            compileError('e2', 2, ["expected ';' at end of declaration", "'x' was not declared in this scope"]),
            compileSuccess('s1', 3),
        ];

        const stats = aggregateErrorStats(events);
        assert.strictEqual(stats.totalCompileErrors, 2);
        assert.strictEqual(stats.totalCompileSuccesses, 1);
        assert.strictEqual(stats.byKnowledgeTag['undeclared_identifier'], 2);
        assert.strictEqual(stats.byKnowledgeTag['missing_semicolon'], 1);
    });

    it('aggregates hint statistics', () => {
        const events: DebugEvent[] = [
            hint('h1', 1, 'hint'),
            hint('h2', 2, 'code_explanation'),
            hint('h3', 3, 'hint'),
        ];

        const stats = aggregateHintStats(events);
        assert.strictEqual(stats.totalHints, 3);
        assert.strictEqual(stats.byIntent['hint'], 2);
        assert.strictEqual(stats.byIntent['code_explanation'], 1);
    });

    it('aggregates time statistics', () => {
        const events: DebugEvent[] = [
            compileError('e1', 1, ['error']),
            compileSuccess('s1', 2),
        ];

        const stats = aggregateTimeStats(events);
        assert.strictEqual(stats.totalCompileDurationMs, 250);
        assert.strictEqual(stats.avgCompileDurationMs, 125);
        assert.strictEqual(stats.medianCompileDurationMs, 125);
    });

    it('aggregates session statistics', () => {
        const events: DebugEvent[] = [
            compileError('e1', 1, ['error']),
            compileSuccess('s1', 2),
            hint('h1', 3, 'hint'),
        ];

        const sessions = aggregateSessionStats(events);
        assert.strictEqual(sessions.length, 1);
        assert.strictEqual(sessions[0].compileErrors, 1);
        assert.strictEqual(sessions[0].compileSuccesses, 1);
        assert.strictEqual(sessions[0].hints, 1);
        assert.strictEqual(sessions[0].durationMs, 2);
    });

    it('computes debug metrics', () => {
        const events: DebugEvent[] = [
            compileError('e1', 1, ['error']),
            compileSuccess('s1', 2),
        ];

        const metrics = computeDebugMetrics(events, []);
        assert.strictEqual(metrics.errorRate, 0.5);
        assert.strictEqual(metrics.avgFixAttempts, 0);
    });
});
