import * as assert from 'assert';
import { describe, it, beforeEach } from 'mocha';
import * as vscode from 'vscode';
import { JourneyService } from '../journey/journeyService';
import { DebugJourneyStore } from '../debug/debugJourneyStore';
import { buildRunOutcomeEvent } from '../run/runService';
import type { RunRecord } from '../run/types';
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
        await service.attach(presenter);

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
        await service.attach(presenter);

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
        await service.attach(presenter);

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

describe('RunService → DebugJourneyStore 写入路径(buildRunOutcomeEvent)', () => {
    let context: vscode.ExtensionContext;
    let store: DebugJourneyStore;

    beforeEach(async () => {
        const tmpUri = vscode.Uri.file(
            `${process.env.TEMP ?? '/tmp'}/classmate-run-journey-test-${Date.now()}-${Math.random()
                .toString(36)
                .slice(2, 9)}`
        );
        await vscode.workspace.fs.createDirectory(tmpUri);
        context = createStubContext(tmpUri);
        store = new DebugJourneyStore(context, 'test-workspace');
    });

    function record(overrides: Partial<RunRecord> = {}): RunRecord {
        return {
            id: `run-${Math.random().toString(36).slice(2, 7)}`,
            exePath: 'C:/ws/main.exe',
            startedAt: 1_000,
            durationMs: 250,
            exitCode: 0,
            timedOut: false,
            needsInteractiveInput: false,
            stdin: '',
            stdout: '',
            stderr: '',
            outputTruncated: false,
            ...overrides,
        };
    }

    it('正常退出(exitCode 0)→ run_success 事件', () => {
        const event = buildRunOutcomeEvent(record(), { sessionId: 's', workspaceId: 'w' });
        assert.strictEqual(event.type, 'run_success');
        assert.strictEqual(event.exitCode, 0);
        assert.strictEqual(event.fileUri, vscode.Uri.file('C:/ws/main.exe').toString());
    });

    it('非零退出 → run_error 事件且 kind 由分类器给出', () => {
        const event = buildRunOutcomeEvent(
            record({ exitCode: 139, stderr: 'Segmentation fault (core dumped)' }),
            { sessionId: 's', workspaceId: 'w' }
        );
        assert.strictEqual(event.type, 'run_error');
        if (event.type !== 'run_error') {
            return assert.fail('unreachable');
        }
        assert.strictEqual(event.kind, 'runtime_segmentation_fault');
        assert.strictEqual(event.executablePath, 'C:/ws/main.exe');
    });

    it('超时/交互兜底 → run_error(TLE / 等待输入)', () => {
        const tle = buildRunOutcomeEvent(record({ exitCode: null, timedOut: true }), {
            sessionId: 's',
            workspaceId: 'w',
        });
        assert.strictEqual(tle.type, 'run_error');
        if (tle.type === 'run_error') {
            assert.strictEqual(tle.kind, 'runtime_time_limit_exceeded');
        }

        const interactive = buildRunOutcomeEvent(
            record({ exitCode: null, needsInteractiveInput: true }),
            { sessionId: 's', workspaceId: 'w' }
        );
        assert.strictEqual(interactive.type, 'run_error');
        if (interactive.type === 'run_error') {
            assert.strictEqual(interactive.kind, 'runtime_interactive_input_needed');
        }
    });

    it('运行事件写入 store 后,JourneyService.buildView 派生出对应 episode', async () => {
        const success = buildRunOutcomeEvent(record({ id: 'run-ok', startedAt: 1_000 }), {
            sessionId: 'session',
            workspaceId: 'test-workspace',
        });
        const failure = buildRunOutcomeEvent(
            record({
                id: 'run-bad',
                startedAt: SEMANTIC_DEDUPE_STEP,
                exitCode: 139,
                stderr: 'Segmentation fault (core dumped)',
            }),
            { sessionId: 'session', workspaceId: 'test-workspace' }
        );
        await store.appendMany([success as DebugEvent, failure as DebugEvent]);

        const service = new JourneyService(store, { confirmClear: async () => false });
        const view = await service.buildView();

        const runSuccessEpisodes = view.episodes.filter((e) =>
            e.entries.some((entry) => entry.kind === 'run_success')
        );
        const runErrorEpisodes = view.episodes.filter((e) =>
            e.entries.some((entry) => entry.kind === 'run_error')
        );
        assert.strictEqual(runSuccessEpisodes.length, 1);
        assert.strictEqual(runSuccessEpisodes[0].resolved, true);
        assert.match(runSuccessEpisodes[0].entries[0].label, /运行成功/);
        assert.strictEqual(runErrorEpisodes.length, 1);
        assert.strictEqual(runErrorEpisodes[0].resolved, false);
        assert.match(runErrorEpisodes[0].entries[0].label, /段错误/);
        service.dispose();
    });
});

/** 与幂等窗口错开的第二个时间戳,保证两条 run 事件不被指纹折叠。 */
const SEMANTIC_DEDUPE_STEP = 1_000_000;

describe('JourneyService 学生手动「已解决」消息链路', () => {
    let context: vscode.ExtensionContext;
    let store: DebugJourneyStore;

    beforeEach(async () => {
        const tmpUri = vscode.Uri.file(
            `${process.env.TEMP ?? '/tmp'}/classmate-resolved-service-test-${Date.now()}-${Math.random()
                .toString(36)
                .slice(2, 9)}`
        );
        await vscode.workspace.fs.createDirectory(tmpUri);
        context = createStubContext(tmpUri);
        store = new DebugJourneyStore(context, 'test-workspace');
    });

    function failingRunEvent(id: string, timestamp: number): DebugEvent {
        return buildRunOutcomeEvent(
            {
                id,
                exePath: 'C:/ws/main.exe',
                startedAt: timestamp,
                durationMs: 250,
                exitCode: 139,
                timedOut: false,
                needsInteractiveInput: false,
                stdout: '',
                stderr: 'Segmentation fault (core dumped)',
            },
            { sessionId: 'session', workspaceId: 'test-workspace' }
        );
    }

    function lastSync(presenter: { messages: RecordedMessage[] }): Extract<
        JourneyExtensionToWebviewMessage,
        { type: 'journey:sync' }
    > {
        const syncs = presenter.messages.filter((m) => m.message.type === 'journey:sync');
        assert.ok(syncs.length >= 1);
        return syncs[syncs.length - 1].message as Extract<
            JourneyExtensionToWebviewMessage,
            { type: 'journey:sync' }
        >;
    }

    it('journey:markResolved 落 store 并立即广播 sync,run_error 卡呈已解决', async () => {
        await store.append(failingRunEvent('run-bad', 1_000));
        const service = new JourneyService(store, { confirmClear: async () => false });
        const presenter = createPresenter();
        await service.attach(presenter);

        await service.handleMessage({ type: 'journey:markResolved', problemKey: 'main' });

        const marks = await store.getResolvedMarks();
        assert.ok(typeof marks.main === 'number');
        const view = lastSync(presenter).view;
        const runEpisode = view.episodes.find((e) => e.runErrorKind !== undefined);
        assert.ok(runEpisode);
        assert.strictEqual(runEpisode.resolved, true);
        assert.strictEqual(runEpisode.resolvedByStudent, true);
        service.dispose();
    });

    it('journey:markUnresolved 撤销后回到未解决态', async () => {
        await store.append(failingRunEvent('run-bad', 1_000));
        const service = new JourneyService(store, { confirmClear: async () => false });
        const presenter = createPresenter();
        await service.attach(presenter);

        await service.handleMessage({ type: 'journey:markResolved', problemKey: 'main' });
        await service.handleMessage({ type: 'journey:markUnresolved', problemKey: 'main' });

        assert.deepStrictEqual(await store.getResolvedMarks(), {});
        const runEpisode = lastSync(presenter).view.episodes.find(
            (e) => e.runErrorKind !== undefined
        );
        assert.ok(runEpisode);
        assert.strictEqual(runEpisode.resolved, false);
        service.dispose();
    });

    it('持久化:handler 落盘后,新建 store 实例(模拟重启)派生仍为已解决', async () => {
        await store.append(failingRunEvent('run-bad', 1_000));
        const service = new JourneyService(store, { confirmClear: async () => false });
        await service.handleMessage({ type: 'journey:markResolved', problemKey: 'main' });
        service.dispose();

        const reopenedStore = new DebugJourneyStore(context, 'test-workspace');
        const reopenedService = new JourneyService(reopenedStore, {
            confirmClear: async () => false,
        });
        const view = await reopenedService.buildView();
        const runEpisode = view.episodes.find((e) => e.runErrorKind !== undefined);
        assert.ok(runEpisode);
        assert.strictEqual(runEpisode.resolved, true);
        reopenedService.dispose();
        reopenedStore.dispose();
    });
});
