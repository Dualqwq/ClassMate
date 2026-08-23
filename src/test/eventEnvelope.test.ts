import * as assert from 'assert';
import { describe, it } from 'mocha';
import {
    computeEventFingerprint,
    stableStringify,
} from '../debug/eventEnvelope';
import type { CompileErrorEvent, CompileSuccessEvent, DebugEvent } from '../debug/types';

function compileErrorEvent(overrides: Partial<CompileErrorEvent> = {}): CompileErrorEvent {
    return {
        id: 'evt-1',
        type: 'compile_error',
        timestamp: 1_000,
        sessionId: 'session',
        workspaceId: 'ws',
        fileUri: 'file:///w/a.cpp',
        stderr: 'b.h:5:10: error: x',
        parsedErrors: [
            { raw: 'raw', file: 'b.h', line: 5, severity: 'error', message: 'x' },
        ],
        exitCode: 1,
        durationMs: 800,
        ...overrides,
    };
}

describe('eventEnvelope (v2 信封语义指纹)', () => {
    it('stableStringify 对对象键顺序无关', () => {
        assert.strictEqual(
            stableStringify({ a: 1, b: { c: 2, d: 3 } }),
            stableStringify({ b: { d: 3, c: 2 }, a: 1 })
        );
    });

    it('fingerprint 排除时间戳/id/durationMs 等易变字段', () => {
        const base = compileErrorEvent();
        const replayed = compileErrorEvent({
            id: 'evt-2',
            timestamp: 99_999,
            durationMs: 1234,
            sessionId: 'another-session',
        });
        assert.strictEqual(computeEventFingerprint(base), computeEventFingerprint(replayed));
    });

    it('不同语义错误得到不同指纹(归属文件/行/消息任一变化)', () => {
        const base = computeEventFingerprint(compileErrorEvent());
        assert.notStrictEqual(base, computeEventFingerprint(compileErrorEvent({ fileUri: 'file:///w/b.cpp' })));
        assert.notStrictEqual(
            base,
            computeEventFingerprint(
                compileErrorEvent({ parsedErrors: [{ raw: 'r', file: 'c.h', line: 6, severity: 'error', message: 'x' }] })
            )
        );
    });

    it('compile_success 与 code_modified 的指纹口径稳定且互异', () => {
        const ok1: CompileSuccessEvent = { id: 'o1', type: 'compile_success', timestamp: 1, sessionId: 's', workspaceId: 'w', fileUri: 'file:///w/a.cpp', exitCode: 0, durationMs: 1 };
        const ok2: CompileSuccessEvent = { id: 'o2', type: 'compile_success', timestamp: 77_777, sessionId: 's', workspaceId: 'w', fileUri: 'file:///w/a.cpp', exitCode: 0, durationMs: 2 };
        assert.strictEqual(computeEventFingerprint(ok1), computeEventFingerprint(ok2));

        const edit1: DebugEvent = { id: 'e1', type: 'code_modified', timestamp: 1, sessionId: 's', workspaceId: 'w', fileUri: 'file:///w/a.cpp', before: 'a', after: 'b', diff: '', trigger: 'manual' };
        const edit2: DebugEvent = { id: 'e2', type: 'code_modified', timestamp: 2, sessionId: 's', workspaceId: 'w', fileUri: 'file:///w/a.cpp', before: 'a', after: 'c', diff: '' , trigger: 'manual' };
        assert.notStrictEqual(computeEventFingerprint(edit1), computeEventFingerprint(edit2));
        assert.notStrictEqual(computeEventFingerprint(ok1), computeEventFingerprint(edit1));
    });
});
