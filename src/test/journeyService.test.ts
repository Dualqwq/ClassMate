import * as assert from 'assert';
import { describe, it, beforeEach } from 'mocha';
import * as vscode from 'vscode';
import { JourneyService } from '../journey/journeyService';
import { DebugJourneyStore } from '../debug/debugJourneyStore';
import type { JourneyExtensionToWebviewMessage } from '../chat/types';
import type { DebugEvent } from '../debug/types';

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

function sampleEvent(timestamp: number): DebugEvent {
    return {
        id: `evt-${timestamp}`,
        type: 'compile_success',
        timestamp,
        sessionId: 'session',
        workspaceId: 'test-workspace',
        exitCode: 0,
        durationMs: 100,
    };
}

interface RecordedMessage {
    message: JourneyExtensionToWebviewMessage;
}

function createPresenter(): {
    messages: RecordedMessage[];
    postMessage(message: JourneyExtensionToWebviewMessage): void;
} {
    const messages: RecordedMessage[] = [];
    return {
        messages,
        postMessage(message: JourneyExtensionToWebviewMessage) {
            messages.push({ message });
        },
    };
}

describe('JourneyService', () => {
    let context: vscode.ExtensionContext;
    let store: DebugJourneyStore;

    beforeEach(async () => {
        const tmpUri = vscode.Uri.file(
            `${process.env.TEMP ?? '/tmp'}/classmate-journey-test-${Date.now()}-${Math.random()
                .toString(36)
                .slice(2, 9)}`
        );
        await vscode.workspace.fs.createDirectory(tmpUri);
        context = createStubContext(tmpUri);
        store = new DebugJourneyStore(context, 'test-workspace');
    });

    it('journey:requestState 推送 journey:sync,视图含已落盘事件', async () => {
        await store.append(sampleEvent(1_000));
        const service = new JourneyService(store, { confirmClear: async () => false });
        const presenter = createPresenter();
        // attach 本身就会推一次初始 sync;requestState 再补推一次。
        service.attach(presenter);

        await service.handleMessage({ type: 'journey:requestState' });

        const syncs = presenter.messages.filter((m) => m.message.type === 'journey:sync');
        assert.strictEqual(syncs.length, 2);
        const last = syncs[1].message as Extract<
            JourneyExtensionToWebviewMessage,
            { type: 'journey:sync' }
        >;
        assert.strictEqual(last.view.metrics.totalEvents, 1);
        service.dispose();
    });

    it('清除经二次确认后才执行,确认后推 cleared + sync', async () => {
        await store.append(sampleEvent(1_000));
        let confirmCalls = 0;
        const service = new JourneyService(store, {
            confirmClear: async () => {
                confirmCalls += 1;
                return true;
            },
        });
        const presenter = createPresenter();
        service.attach(presenter);

        await service.handleMessage({ type: 'journey:clearAll' });

        assert.strictEqual(confirmCalls, 1);
        assert.strictEqual((await store.getEvents()).length, 0);
        const kinds = presenter.messages.map((m) => m.message.type);
        assert.ok(kinds.includes('journey:cleared'));
        assert.ok(kinds.includes('journey:sync'));
        service.dispose();
    });

    it('二次确认被拒绝时不清除、不推 cleared', async () => {
        await store.append(sampleEvent(1_000));
        const service = new JourneyService(store, { confirmClear: async () => false });
        const presenter = createPresenter();
        service.attach(presenter);

        await service.handleMessage({ type: 'journey:clearAll' });

        assert.strictEqual((await store.getEvents()).length, 1);
        assert.ok(!presenter.messages.some((m) => m.message.type === 'journey:cleared'));
        service.dispose();
    });

    it('面板未 attach 时不推送,但 buildView 仍可独立派生', async () => {
        await store.append(sampleEvent(1_000));
        const service = new JourneyService(store, { confirmClear: async () => false });
        await service.handleMessage({ type: 'journey:requestState' });

        const view = await service.buildView();
        assert.strictEqual(view.metrics.totalEvents, 1);
        service.dispose();
    });
});
