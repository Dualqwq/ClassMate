import * as assert from 'assert';
import { describe, it } from 'mocha';
import {
    buildErrorLifecycles,
    findFixingEditForSignature,
    findFixingEdits,
    isErrorResolved,
} from '../debug/errorLifecycle';
import { createErrorSignature } from '../debug/errorFingerprint';
import type { CompileErrorEvent, CodeModifiedEvent, CompileSuccessEvent, DebugEvent } from '../debug/types';

function createCompileError(
    id: string,
    timestamp: number,
    messages: string[],
    sessionId = 'session'
): CompileErrorEvent {
    return {
        id,
        type: 'compile_error',
        timestamp,
        sessionId,
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

function createCompileSuccess(
    id: string,
    timestamp: number,
    sessionId = 'session'
): CompileSuccessEvent {
    return {
        id,
        type: 'compile_success',
        timestamp,
        sessionId,
        workspaceId: 'ws',
        fileUri: 'file:///main.cpp',
        exitCode: 0,
        durationMs: 100,
    };
}

function createCodeModified(
    id: string,
    timestamp: number,
    sessionId = 'session'
): CodeModifiedEvent {
    return {
        id,
        type: 'code_modified',
        timestamp,
        sessionId,
        workspaceId: 'ws',
        fileUri: 'file:///main.cpp',
        before: '',
        after: '',
        diff: '',
        trigger: 'pre_compile',
    };
}

describe('Error Lifecycle', () => {
    it('marks error as resolved when next compile succeeds', () => {
        const error = createCompileError('err-1', 1, ["'x' was not declared in this scope"]);
        const success = createCompileSuccess('succ-1', 2);
        const events: DebugEvent[] = [error, success];

        const result = isErrorResolved(error, events);
        assert.strictEqual(result.resolved, true);
        assert.strictEqual(result.attempts, 1);
        assert.strictEqual(result.resolvedAt, 2);
    });

    it('keeps error unresolved when it reappears in next compile', () => {
        const error = createCompileError('err-1', 1, ["'x' was not declared in this scope"]);
        const again = createCompileError('err-2', 2, ["'x' was not declared in this scope"]);
        const events: DebugEvent[] = [error, again];

        const result = isErrorResolved(error, events);
        assert.strictEqual(result.resolved, false);
        assert.strictEqual(result.attempts, 1);
    });

    it('respects lookAheadCompiles limit', () => {
        const error = createCompileError('err-1', 1, ["'x' was not declared in this scope"]);
        const e2 = createCompileError('err-2', 2, ["'x' was not declared in this scope"]);
        const e3 = createCompileError('err-3', 3, ["'x' was not declared in this scope"]);
        const success = createCompileSuccess('succ-1', 4);
        const events: DebugEvent[] = [error, e2, e3, success];

        const result = isErrorResolved(error, events, { lookAheadCompiles: 2 });
        assert.strictEqual(result.resolved, false);
        assert.strictEqual(result.attempts, 2);
    });

    it('links resolving edit when modification happens before success', () => {
        const error = createCompileError('err-1', 1, ["'x' was not declared in this scope"]);
        const edit = createCodeModified('edit-1', 2);
        const success = createCompileSuccess('succ-1', 3);
        const events: DebugEvent[] = [error, edit, success];

        const result = isErrorResolved(error, events);
        assert.strictEqual(result.resolved, true);
        assert.strictEqual(result.resolvingEditId, 'edit-1');
    });

    it('finds fixing edit for a single signature', () => {
        const error = createCompileError('err-1', 1, ["'x' was not declared in this scope"]);
        const edit = createCodeModified('edit-1', 2);
        const success = createCompileSuccess('succ-1', 3);
        const events: DebugEvent[] = [error, edit, success];

        const signature = createErrorSignature(error.parsedErrors[0], { includeCode: false, includeFile: false });
        const fixingEdit = findFixingEditForSignature(error, events, signature);
        assert.ok(fixingEdit);
        assert.strictEqual(fixingEdit?.id, 'edit-1');
    });

    it('returns per-signature fixing edits when signatures resolve at different times', () => {
        // t=1: error has two distinct signatures A and B.
        const error = createCompileError('err-1', 1, [
            "'x' was not declared in this scope",
            "expected ';' before 'return'",
        ]);

        // t=2: edit A fixes the undeclared error.
        const editA = createCodeModified('edit-A', 2);

        // t=3: only missing_semicolon remains.
        const e2 = createCompileError('err-2', 3, ["expected ';' before 'return'"]);

        // t=4: edit B fixes the semicolon error.
        const editB = createCodeModified('edit-B', 4);

        // t=5: compile succeeds.
        const success = createCompileSuccess('succ-1', 5);

        const events: DebugEvent[] = [error, editA, e2, editB, success];

        const results = findFixingEdits(error, events);
        assert.strictEqual(results.length, 2);

        const undeclaredResult = results.find(
            (r) => r.signature.knowledgeTags.includes('undeclared_identifier')
        );
        const semicolonResult = results.find(
            (r) => r.signature.knowledgeTags.includes('missing_semicolon')
        );

        assert.ok(undeclaredResult);
        assert.ok(semicolonResult);
        assert.strictEqual(undeclaredResult?.edit?.id, 'edit-A');
        assert.strictEqual(semicolonResult?.edit?.id, 'edit-B');
    });

    it('attributes same fixing edit to multiple signatures fixed together', () => {
        const error = createCompileError('err-1', 1, [
            "'x' was not declared in this scope",
            "expected ';' before 'return'",
        ]);
        const edit = createCodeModified('edit-both', 2);
        const success = createCompileSuccess('succ-1', 3);
        const events: DebugEvent[] = [error, edit, success];

        const results = findFixingEdits(error, events);
        assert.strictEqual(results.length, 2);
        assert.ok(results.every((r) => r.edit?.id === 'edit-both'));
    });

    it('returns undefined edit for unresolved signature', () => {
        const error = createCompileError('err-1', 1, ["'x' was not declared in this scope"]);
        const again = createCompileError('err-2', 2, ["'x' was not declared in this scope"]);
        const events: DebugEvent[] = [error, again];

        const signature = createErrorSignature(error.parsedErrors[0], { includeCode: false, includeFile: false });
        const fixingEdit = findFixingEditForSignature(error, events, signature);
        assert.strictEqual(fixingEdit, undefined);

        const results = findFixingEdits(error, events);
        assert.strictEqual(results.length, 1);
        assert.strictEqual(results[0].edit, undefined);
    });

    it('builds lifecycles with per-signature resolvingEditId', () => {
        const error = createCompileError('err-1', 1, [
            "'x' was not declared in this scope",
            "expected ';' before 'return'",
        ]);
        const editA = createCodeModified('edit-A', 2);
        const e2 = createCompileError('err-2', 3, ["expected ';' before 'return'"]);
        const editB = createCodeModified('edit-B', 4);
        const success = createCompileSuccess('succ-1', 5);
        const events: DebugEvent[] = [error, editA, e2, editB, success];

        const lifecycles = buildErrorLifecycles(events);
        const undeclaredLifecycle = lifecycles.find(
            (l) => l.signature.knowledgeTags.includes('undeclared_identifier')
        );
        const semicolonLifecycle = lifecycles.find(
            (l) => l.signature.knowledgeTags.includes('missing_semicolon')
        );

        assert.ok(undeclaredLifecycle);
        assert.ok(semicolonLifecycle);
        assert.strictEqual(undeclaredLifecycle?.resolvingEditId, 'edit-A');
        assert.strictEqual(semicolonLifecycle?.resolvingEditId, 'edit-B');
    });

    it('builds lifecycles for all error diagnostics', () => {
        const error = createCompileError('err-1', 1, [
            "'x' was not declared in this scope",
            "expected ';' before 'return'",
        ]);
        const success = createCompileSuccess('succ-1', 2);
        const events: DebugEvent[] = [error, success];

        const lifecycles = buildErrorLifecycles(events);
        assert.strictEqual(lifecycles.length, 2);
        assert.ok(lifecycles.every((l) => l.resolvedAt));
    });
});
