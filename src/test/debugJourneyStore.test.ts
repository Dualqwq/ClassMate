import * as assert from 'assert';
import { describe, it, beforeEach } from 'mocha';
import * as vscode from 'vscode';
import { DebugJourneyStore } from '../debug/debugJourneyStore';
import { isCompileError, type DebugEvent } from '../debug/types';

function createStubContext(globalStorageUri: vscode.Uri): vscode.ExtensionContext {
    const state = new Map<string, unknown>();

    return {
        globalStorageUri,
        globalState: {
            get: <T>(key: string, defaultValue?: T): T | undefined => {
                return state.has(key) ? (state.get(key) as T) : defaultValue;
            },
            update: async (key: string, value: unknown) => {
                if (value === undefined) {
                    state.delete(key);
                } else {
                    state.set(key, value);
                }
            },
        },
    } as unknown as vscode.ExtensionContext;
}

describe('DebugJourneyStore', () => {
    let context: vscode.ExtensionContext;
    let store: DebugJourneyStore;

    beforeEach(async () => {
        const tmpUri = vscode.Uri.file(
            `${process.env.TEMP ?? '/tmp'}/classmate-test-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
        );
        await vscode.workspace.fs.createDirectory(tmpUri);
        context = createStubContext(tmpUri);
        store = new DebugJourneyStore(context, 'test-workspace');
    });

    it('appends and retrieves a single event', async () => {
        const event: DebugEvent = {
            id: '1',
            type: 'compile_success',
            timestamp: Date.now(),
            sessionId: 'session',
            workspaceId: 'test-workspace',
            exitCode: 0,
            durationMs: 100,
        };

        await store.append(event);
        const events = await store.getEvents();
        assert.strictEqual(events.length, 1);
        assert.strictEqual(events[0].id, '1');
    });

    it('filters events by type', async () => {
        await store.append({
            id: '1',
            type: 'compile_success',
            timestamp: 1,
            sessionId: 'session',
            workspaceId: 'test-workspace',
            exitCode: 0,
            durationMs: 100,
        });
        await store.append({
            id: '2',
            type: 'compile_error',
            timestamp: 2,
            sessionId: 'session',
            workspaceId: 'test-workspace',
            stderr: 'error',
            parsedErrors: [],
            exitCode: 1,
            durationMs: 100,
        });

        const errors = await store.getEvents({ types: ['compile_error'] });
        assert.strictEqual(errors.length, 1);
        assert.strictEqual(errors[0].id, '2');
    });

    it('truncates oversized fields', async () => {
        const huge = 'x'.repeat(20 * 1024);
        await store.append({
            id: '1',
            type: 'compile_error',
            timestamp: 1,
            sessionId: 'session',
            workspaceId: 'test-workspace',
            stderr: huge,
            parsedErrors: [],
            exitCode: 1,
            durationMs: 100,
        });

        const events = await store.getEvents({ types: ['compile_error'] });
        assert.strictEqual(events.length, 1);
        const first = events[0];
        assert.ok(isCompileError(first));
        assert.ok(first.stderr.endsWith('\n<truncated>'));
        assert.ok(first.stderr.length < huge.length);
    });

    it('clears all stored events', async () => {
        await store.append({
            id: '1',
            type: 'compile_success',
            timestamp: 1,
            sessionId: 'session',
            workspaceId: 'test-workspace',
            exitCode: 0,
            durationMs: 100,
        });

        await store.clear();
        const events = await store.getEvents();
        assert.strictEqual(events.length, 0);
    });

    it('appends incrementally: repeated appendMany keep order and content (O(1) 追加)', async () => {
        for (let round = 0; round < 3; round++) {
            await store.appendMany([
                {
                    id: `e-${round}`,
                    type: 'compile_success',
                    timestamp: round,
                    sessionId: 'session',
                    workspaceId: 'test-workspace',
                    exitCode: 0,
                    durationMs: 10,
                },
            ]);
        }

        const events = await store.getEvents();
        assert.strictEqual(events.length, 3);
        assert.deepStrictEqual(
            events.map((e) => e.id),
            ['e-0', 'e-1', 'e-2'],
            '追加写入不得破坏既有行,新事件按追加顺序落在文件尾部'
        );
    });

    it('fires onDidAppend with the sanitized batch after a successful append', async () => {
        const batches: number[] = [];
        const disposable = store.onDidAppend((events) => batches.push(events.length));
        try {
            await store.appendMany([
                {
                    id: 'x-1',
                    type: 'compile_success',
                    timestamp: 1,
                    sessionId: 'session',
                    workspaceId: 'test-workspace',
                    exitCode: 0,
                    durationMs: 10,
                },
                {
                    id: 'x-2',
                    type: 'compile_success',
                    timestamp: 2,
                    sessionId: 'session',
                    workspaceId: 'test-workspace',
                    exitCode: 0,
                    durationMs: 10,
                },
            ]);
            assert.deepStrictEqual(batches, [2]);
        } finally {
            disposable.dispose();
        }
    });
});
