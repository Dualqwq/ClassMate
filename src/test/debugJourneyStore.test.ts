import * as assert from 'assert';
import { describe, it, beforeEach } from 'mocha';
import * as vscode from 'vscode';
import { DebugJourneyStore } from '../debug/debugJourneyStore';
import { isCompileError, isRunError, type DebugEvent } from '../debug/types';
import { SEMANTIC_DEDUPE_WINDOW_MS } from '../debug/eventEnvelope';
import { getEventsFileUri, getWorkspaceStorageUri } from '../debug/storagePath';

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

    it('clear 幂等:记录文件不存在时照常成功(重复清除也不报错)', async () => {
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
        assert.strictEqual((await store.getEvents()).length, 0);

        // 第二次清除:events.jsonl/resolved.json 已不存在,delete 会报
        // FileNotFound,必须容忍(幂等清除不要求文件存在)而非把成功变失败。
        await store.clear();
        assert.strictEqual((await store.getEvents()).length, 0);
        assert.deepStrictEqual(await store.getResolvedMarks(), {});
    });

    it('clear 遇到非 FileNotFound 删除错误时向上抛(不再静默假成功)', async () => {
        // 用真实文件系统制造不可删除的路径:events.jsonl 位置放一个非空目录,
        // 非递归 delete 必然失败(ENOTEMPTY 一族,非 FileNotFound),等价于
        // 真实环境里杀软/索引器锁文件导致的删除失败。
        const eventsUri = getEventsFileUri(
            getWorkspaceStorageUri(context.globalStorageUri, 'test-workspace')
        );
        await vscode.workspace.fs.createDirectory(eventsUri);
        const blocker = vscode.Uri.joinPath(eventsUri, 'lock.txt');
        await vscode.workspace.fs.writeFile(blocker, Buffer.from('locked'));

        await assert.rejects(
            store.clear(),
            (err: unknown) =>
                !(err instanceof vscode.FileSystemError && err.code === 'FileNotFound')
        );

        // 失败如实暴露:占位目录与内容原样保留,没有被静默清理或假成功。
        const stat = await vscode.workspace.fs.stat(eventsUri);
        assert.strictEqual(stat.type & vscode.FileType.Directory, vscode.FileType.Directory);
        await vscode.workspace.fs.stat(blocker);
    });

    it('clear 清空 globalState:三个带 workspace 后缀的键与无后缀历史旧键都删除', async () => {
        await store.append({
            id: '1',
            type: 'compile_success',
            timestamp: 1,
            sessionId: 'session',
            workspaceId: 'test-workspace',
            exitCode: 0,
            durationMs: 100,
        });
        await store.markProblemResolved('main');
        // 预置无后缀的历史遗留键(旧版本写入形态)。
        const EVENTS_KEY = 'classmate.debugJourney.events.v1';
        const INDEX_KEY = 'classmate.debugJourney.index.v1';
        const RESOLVED_KEY = 'classmate.debugJourney.resolved.v1';
        await context.globalState.update(EVENTS_KEY, [{ id: 'legacy' }]);
        await context.globalState.update(INDEX_KEY, { total: 9 });
        await context.globalState.update(RESOLVED_KEY, { main: 1 });

        await store.clear();

        const suffix = '.test-workspace';
        assert.strictEqual(
            context.globalState.get(`${EVENTS_KEY}${suffix}`),
            undefined,
            '热缓存(带后缀)必须清掉,否则清除后的第一个 append 会把旧事件并回来'
        );
        assert.strictEqual(
            context.globalState.get(`${INDEX_KEY}${suffix}`),
            undefined,
            'index 轻量副本(带后缀)必须清掉'
        );
        assert.strictEqual(
            context.globalState.get(`${RESOLVED_KEY}${suffix}`),
            undefined,
            'resolved 副本(带后缀)必须清掉'
        );
        assert.strictEqual(
            context.globalState.get(EVENTS_KEY),
            undefined,
            '无后缀历史旧键一并清理'
        );
        assert.strictEqual(context.globalState.get(INDEX_KEY), undefined);
        assert.strictEqual(context.globalState.get(RESOLVED_KEY), undefined);
    });

    it('clear 后首次 append:globalState 热缓存只含新事件(旧缓存不得回魂)', async () => {
        await store.append({
            id: 'old-1',
            type: 'compile_success',
            timestamp: 1,
            sessionId: 'session',
            workspaceId: 'test-workspace',
            fileUri: 'file:///w/old.cpp',
            exitCode: 0,
            durationMs: 10,
        });

        await store.clear();

        await store.append({
            id: 'new-1',
            type: 'compile_success',
            timestamp: 2,
            sessionId: 'session',
            workspaceId: 'test-workspace',
            fileUri: 'file:///w/new.cpp',
            exitCode: 0,
            durationMs: 10,
        });

        const cache = context.globalState.get<DebugEvent[]>(
            'classmate.debugJourney.events.v1.test-workspace',
            []
        );
        assert.deepStrictEqual(
            cache.map((e) => e.id),
            ['new-1'],
            '清除后的热缓存只允许包含清除之后写入的新事件'
        );
    });

    it('clear 重置语义指纹窗口:清除后窗口内同错误重新落盘(不被幂等去重吞掉)', async () => {
        let now = 100_000;
        const windowedStore = new DebugJourneyStore(context, 'test-workspace', { now: () => now });
        const makeEvent = (id: string): DebugEvent => ({
            id,
            type: 'compile_error',
            // 与既有幂等窗口用例同口径:时间戳是易变字段,不参与指纹,
            // 两次事件语义指纹完全相同。
            timestamp: now,
            sessionId: 'session',
            workspaceId: 'test-workspace',
            fileUri: 'file:///w/a.cpp',
            stderr: 'b.h:5:10: error: x',
            parsedErrors: [{ raw: 'r', file: 'b.h', line: 5, severity: 'error', message: 'x' }],
            exitCode: 1,
            durationMs: 100,
        });

        await windowedStore.append(makeEvent('before-clear'));
        await windowedStore.clear();

        // 窗口内(5s 未过)重编完全相同的错误:清除语义=从头记录,必须落盘;
        // 修复前此处被残留的幂等指纹跳过,清除后的第一条错误丢失。
        now += 500;
        await windowedStore.append(makeEvent('after-clear'));

        const events = await windowedStore.getEvents();
        assert.deepStrictEqual(
            events.map((e) => e.id),
            ['after-clear'],
            '清除后同指纹错误必须重新落盘,不得被幂等窗口吞掉'
        );
        const index = await windowedStore.getIndex();
        assert.strictEqual(index.total, 1);
        windowedStore.dispose();
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
                    // 语义可区分(不同文件):v2 幂等只吞同指纹重复,不吞新事件。
                    fileUri: `file:///w/f${round}.cpp`,
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
                    fileUri: 'file:///w/a.cpp',
                    exitCode: 0,
                    durationMs: 10,
                },
                {
                    id: 'x-2',
                    type: 'compile_success',
                    timestamp: 2,
                    sessionId: 'session',
                    workspaceId: 'test-workspace',
                    fileUri: 'file:///w/b.cpp',
                    exitCode: 0,
                    durationMs: 10,
                },
            ]);
            assert.deepStrictEqual(batches, [2]);
        } finally {
            disposable.dispose();
        }
    });

    it('v2 信封:同语义事件在幂等窗口内重复 append 只落一条', async () => {
        let now = 50_000;
        const windowedStore = new DebugJourneyStore(context, 'test-workspace', { now: () => now });
        const makeEvent = (id: string): DebugEvent => ({
            id,
            type: 'compile_error',
            // 时间戳是易变字段,不参与指纹;两次"复制"只差 id/timestamp。
            timestamp: now,
            sessionId: 'session',
            workspaceId: 'test-workspace',
            fileUri: 'file:///w/a.cpp',
            stderr: 'b.h:5:10: error: x',
            parsedErrors: [{ raw: 'r', file: 'b.h', line: 5, severity: 'error', message: 'x' }],
            exitCode: 1,
            durationMs: 100,
        });

        await windowedStore.append(makeEvent('first'));
        now += 500;
        await windowedStore.append(makeEvent('duplicate'));
        now += 500;
        await windowedStore.append(makeEvent('duplicate-again'));

        const events = await windowedStore.getEvents();
        assert.strictEqual(events.length, 1, '窗口内同指纹重复必须被跳过');
        assert.strictEqual(events[0].id, 'first');

        // 窗口外(学生真实地又编了一次同样的错):正常落盘。
        now += SEMANTIC_DEDUPE_WINDOW_MS + 1_000;
        await windowedStore.append(makeEvent('later-real'));
        assert.strictEqual((await windowedStore.getEvents()).length, 2);

        // 写入事件带 v2 信封。
        const stored = await windowedStore.getEvents();
        assert.strictEqual(stored.every((e) => e.schemaVersion === 2), true);
        assert.ok(stored.every((e) => typeof e.fingerprint === 'string' && e.fingerprint.length > 0));
        windowedStore.dispose();
    });

    it('旧格式迁移:无信封的历史行照读不炸并标记 schemaVersion=1', async () => {
        const legacyLine = JSON.stringify({
            id: 'legacy-1',
            type: 'compile_success',
            timestamp: 1,
            sessionId: 'session',
            workspaceId: 'test-workspace',
            exitCode: 0,
            durationMs: 10,
        });
        // 直写 events.jsonl 模拟旧版本数据(appendFile 到空文件即首行)。
        const bytes = Buffer.from(legacyLine + '\n', 'utf-8');
        await vscode.workspace.fs.writeFile(
            getEventsFileUri(getWorkspaceStorageUri(context.globalStorageUri, 'test-workspace')),
            bytes
        );

        const events = await store.getEvents();
        assert.strictEqual(events.length, 1);
        assert.strictEqual(events[0].id, 'legacy-1');
        assert.strictEqual(events[0].schemaVersion, 1);
        assert.strictEqual((events[0] as { fingerprint?: string }).fingerprint, undefined);
    });

    it('run 归位字段往返:problemKey/sourceFileUri 随事件持久化读回', async () => {
        await store.append({
            id: 'run-1',
            type: 'run_error',
            timestamp: 1,
            sessionId: 'session',
            workspaceId: 'test-workspace',
            fileUri: 'file:///w/main.exe',
            executablePath: 'C:/w/main.exe',
            stdout: '',
            stderr: 'boom',
            exitCode: 139,
            durationMs: 10,
            kind: 'runtime_segmentation_fault',
            sourceFileUri: 'file:///w/main.cpp',
            problemKey: '两数之和',
        });

        const events = await store.getEvents();
        assert.strictEqual(events.length, 1);
        const stored = events[0];
        if (!isRunError(stored)) {
            return assert.fail('unreachable');
        }
        assert.strictEqual(stored.sourceFileUri, 'file:///w/main.cpp');
        assert.strictEqual(stored.problemKey, '两数之和');
    });

    it('旧 run 事件(无归位字段)读回后字段为 undefined,照常可用', async () => {
        const legacyLine = JSON.stringify({
            id: 'legacy-run',
            type: 'run_error',
            timestamp: 1,
            sessionId: 'session',
            workspaceId: 'test-workspace',
            fileUri: 'file:///w/main.exe',
            executablePath: 'C:/w/main.exe',
            stdout: '',
            stderr: 'Segmentation fault',
            exitCode: 139,
            durationMs: 10,
            kind: 'runtime_segmentation_fault',
        });
        await vscode.workspace.fs.writeFile(
            getEventsFileUri(getWorkspaceStorageUri(context.globalStorageUri, 'test-workspace')),
            Buffer.from(legacyLine + '\n', 'utf-8')
        );

        const events = await store.getEvents();
        assert.strictEqual(events.length, 1);
        assert.strictEqual(events[0].problemKey, undefined);
        assert.strictEqual((events[0] as { sourceFileUri?: string }).sourceFileUri, undefined);
    });
});

describe('DebugJourneyStore 学生手动「已解决」标记(problemKey 粒度)', () => {
    let context: vscode.ExtensionContext;
    let store: DebugJourneyStore;

    beforeEach(async () => {
        const tmpUri = vscode.Uri.file(
            `${process.env.TEMP ?? '/tmp'}/classmate-resolved-test-${Date.now()}-${Math.random()
                .toString(36)
                .slice(2, 9)}`
        );
        await vscode.workspace.fs.createDirectory(tmpUri);
        context = createStubContext(tmpUri);
        store = new DebugJourneyStore(context, 'test-workspace');
    });

    it('mark → get 往返:标记写入时间戳', async () => {
        let now = 123_456;
        const clocked = new DebugJourneyStore(context, 'test-workspace', { now: () => now });
        await clocked.markProblemResolved('main');
        const marks = await clocked.getResolvedMarks();
        assert.deepStrictEqual(marks, { main: 123_456 });
        clocked.dispose();
    });

    it('持久化:新建 store 实例(模拟重启 VS Code)后标记仍在', async () => {
        await store.markProblemResolved('main');
        await store.markProblemResolved('card');
        const reopened = new DebugJourneyStore(context, 'test-workspace');
        assert.deepStrictEqual(Object.keys(await reopened.getResolvedMarks()).sort(), [
            'card',
            'main',
        ]);
        reopened.dispose();
    });

    it('撤销:markProblemUnresolved 删掉标记;未标记的题撤销是 no-op', async () => {
        await store.markProblemResolved('main');
        await store.markProblemUnresolved('main');
        assert.deepStrictEqual(await store.getResolvedMarks(), {});

        // 再次撤销不报错、不复活任何东西。
        await store.markProblemUnresolved('main');
        assert.deepStrictEqual(await store.getResolvedMarks(), {});
    });

    it('clear() 连同已解决标记一起清空', async () => {
        await store.append({
            id: '1',
            type: 'run_error',
            timestamp: 1,
            sessionId: 'session',
            workspaceId: 'test-workspace',
            fileUri: 'file:///w/main.exe',
            executablePath: 'C:/w/main.exe',
            stdout: '',
            stderr: 'boom',
            exitCode: 1,
            durationMs: 10,
            kind: 'runtime_unknown',
        });
        await store.markProblemResolved('main');

        await store.clear();

        assert.deepStrictEqual(await store.getEvents(), []);
        assert.deepStrictEqual(await store.getResolvedMarks(), {});
    });
});
