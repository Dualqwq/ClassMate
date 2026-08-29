import * as assert from 'assert';
import { describe, it, beforeEach } from 'mocha';
import * as vscode from 'vscode';
import { JourneyService } from '../journey/journeyService';
import { DebugJourneyStore } from '../debug/debugJourneyStore';
import { getResolvedFileUri, getWorkspaceStorageUri } from '../debug/storagePath';
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

    it('清除失败:弹错误提示、不向调用方抛出,并按磁盘数据重推 sync', async () => {
        await store.append(sampleEvent(1_000));
        const errorMessages: string[] = [];
        const service = new JourneyService(store, {
            confirmClear: async () => true,
            // 生产路径默认 void showErrorMessage(fire-and-forget);单测注入记录器。
            notifyClearError: (message: string) => errorMessages.push(message),
        });
        const presenter = createPresenter();
        await service.attach(presenter);

        // 用真实文件系统制造不可删除的路径:resolved.json 位置放一个非空目录,
        // clear() 删它必然失败(ENOTEMPTY 一族,非 FileNotFound),等价于真实
        // 环境里杀软/索引器锁文件导致的删除失败;events.jsonl 保持真实可清。
        const resolvedUri = getResolvedFileUri(
            getWorkspaceStorageUri(context.globalStorageUri, 'test-workspace')
        );
        await vscode.workspace.fs.createDirectory(resolvedUri);
        await vscode.workspace.fs.writeFile(
            vscode.Uri.joinPath(resolvedUri, 'lock.txt'),
            Buffer.from('locked')
        );

        // 不向调用方抛出:handleMessage 正常返回。
        await service.handleMessage({ type: 'journey:clearAll' });

        assert.deepStrictEqual(errorMessages, ['清除调试记录失败，请稍后重试。']);
        // 清除中断(events.jsonl 已删、resolved 路径删除失败)不得广播 cleared,
        // 重推的 sync 必须反映当前磁盘状态——UI 与磁盘保持一致,不呈现假象。
        assert.ok(!presenter.messages.some((m) => m.message.type === 'journey:cleared'));
        const syncs = presenter.messages.filter((m) => m.message.type === 'journey:sync');
        assert.strictEqual(syncs.length, 2, 'attach 初始 sync + 失败后的重推 sync');
        const diskCount = (await store.getEvents()).length;
        const last = syncs[1].message as Extract<
            JourneyExtensionToWebviewMessage,
            { type: 'journey:sync' }
        >;
        assert.strictEqual(
            last.view.metrics.totalEvents,
            diskCount,
            '失败后的 sync 必须与磁盘实际内容一致'
        );
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

    it('terminate 解包出的陌生异常类名 → kind=unknown 且 errorDetail 随事件透传', () => {
        const event = buildRunOutcomeEvent(
            record({
                exitCode: 134,
                stderr: [
                    "terminate called after throwing an instance of 'MyError'",
                    '  what():  something bad',
                ].join('\n'),
            }),
            { sessionId: 's', workspaceId: 'w' }
        );
        if (event.type !== 'run_error') {
            return assert.fail('unreachable');
        }
        assert.strictEqual(event.kind, 'runtime_unknown');
        assert.ok(event.errorDetail?.includes('MyError'));
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
        const runtimeCard = view.mistakeCards.find(
            (card) => card.tag === 'runtime_segmentation_fault'
        );
        assert.ok(runtimeCard, 'JourneyService.buildView 应把 run_error 同步到错题本');
        assert.strictEqual(runtimeCard.unresolvedCount, 1);
        assert.deepStrictEqual(runtimeCard.fixes, []);
        service.dispose();
    });

    it('归位信息(attribution)写入事件:fileUri 保持 exe,源文件与题目键走新可选字段', () => {
        const attribution = { sourceFileUri: 'file:///w/main.cpp', problemKey: '两数之和' };
        const success = buildRunOutcomeEvent(record(), { sessionId: 's', workspaceId: 'w' }, attribution);
        assert.strictEqual(success.type, 'run_success');
        assert.strictEqual(success.fileUri, vscode.Uri.file('C:/ws/main.exe').toString());
        assert.strictEqual(success.sourceFileUri, 'file:///w/main.cpp');
        assert.strictEqual(success.problemKey, '两数之和');

        const failure = buildRunOutcomeEvent(
            record({ exitCode: 139, stderr: 'Segmentation fault (core dumped)' }),
            { sessionId: 's', workspaceId: 'w' },
            attribution
        );
        if (failure.type !== 'run_error') {
            return assert.fail('unreachable');
        }
        assert.strictEqual(failure.fileUri, vscode.Uri.file('C:/ws/main.exe').toString());
        assert.strictEqual(failure.sourceFileUri, 'file:///w/main.cpp');
        assert.strictEqual(failure.problemKey, '两数之和');
    });

    it('无归位信息(旧形态)时事件不带新字段,消费侧按现状回退', () => {
        const event = buildRunOutcomeEvent(record(), { sessionId: 's', workspaceId: 'w' });
        assert.strictEqual('sourceFileUri' in event, false);
        assert.strictEqual('problemKey' in event, false);
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
        const runtimeCard = view.mistakeCards.find(
            (card) => card.tag === 'runtime_segmentation_fault'
        );
        assert.ok(runtimeCard);
        assert.strictEqual(runtimeCard.resolvedCount, 1);
        assert.strictEqual(runtimeCard.unresolvedCount, 0);
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
