import * as assert from 'assert';
import { describe, it } from 'mocha';
import {
    buildKnowledgeCards,
    buildKnowledgeCardsFromEvents,
} from '../debug/knowledgeCardBuilder';
import type { DebugJourneyStore } from '../debug/debugJourneyStore';
import type {
    CompileErrorEvent,
    DebugEvent,
    RunErrorEvent,
    RunSuccessEvent,
} from '../debug/types';

function runError(overrides: Partial<RunErrorEvent> = {}): RunErrorEvent {
    return {
        id: 'run-1',
        type: 'run_error',
        timestamp: 1_000,
        sessionId: 'session',
        workspaceId: 'ws',
        fileUri: 'file:///w/main.exe',
        executablePath: 'C:/w/main.exe',
        stdout: '',
        stderr: '',
        exitCode: 7,
        durationMs: 100,
        kind: 'runtime_unknown',
        ...overrides,
    };
}

function runSuccess(overrides: Partial<RunSuccessEvent> = {}): RunSuccessEvent {
    return {
        id: 'run-ok',
        type: 'run_success',
        timestamp: 2_000,
        sessionId: 'session',
        workspaceId: 'ws',
        fileUri: 'file:///w/main.exe',
        exitCode: 0,
        durationMs: 100,
        ...overrides,
    };
}

function compileError(overrides: Partial<CompileErrorEvent> = {}): CompileErrorEvent {
    return {
        id: 'compile-1',
        type: 'compile_error',
        timestamp: 500,
        sessionId: 'session',
        workspaceId: 'ws',
        fileUri: 'file:///w/main.cpp',
        stderr: "main.cpp:1:1: error: x was not declared in this scope",
        parsedErrors: [
            {
                raw: "main.cpp:1:1: error: x was not declared in this scope",
                file: 'file:///w/main.cpp',
                line: 1,
                severity: 'error',
                message: 'x was not declared in this scope',
            },
        ],
        exitCode: 1,
        durationMs: 100,
        ...overrides,
    };
}

describe('run_error knowledge cards', () => {
    it('runtime_unknown 也能生成事实性卡片且不伪造学生 concrete fix', () => {
        const events: DebugEvent[] = [
            runError({
                errorDetail: '程序抛出了一个未被处理的异常（类型：MyError）',
            }),
        ];

        const cards = buildKnowledgeCardsFromEvents(events);

        assert.strictEqual(cards.length, 1);
        const card = cards[0];
        assert.strictEqual(card.tag, 'runtime_unknown');
        assert.strictEqual(card.frequency, 1);
        assert.strictEqual(card.resolvedCount, 0);
        assert.strictEqual(card.unresolvedCount, 1);
        assert.strictEqual(card.problemKey, 'main');
        assert.strictEqual(card.fileUri, 'file:///w/main.exe');
        assert.strictEqual(
            card.phenomenon,
            '运行出错：原因不明(退出码 7)；程序抛出了一个未被处理的异常（类型：MyError）'
        );
        assert.deepStrictEqual(card.correctingEditIds, []);
        assert.deepStrictEqual(card.concreteFixes, []);
    });

    it('编译卡与运行卡共存，同 kind 重复 occurrence 按 tag 合并', () => {
        const cards = buildKnowledgeCardsFromEvents([
            compileError(),
            runError({
                id: 'run-old',
                timestamp: 1_000,
                kind: 'runtime_segmentation_fault',
                exitCode: 139,
            }),
            runError({
                id: 'run-new',
                timestamp: 2_000,
                kind: 'runtime_segmentation_fault',
                exitCode: 3221225477,
            }),
        ]);

        assert.deepStrictEqual(
            cards.map((card) => card.tag).sort(),
            ['runtime_segmentation_fault', 'undeclared_identifier'].sort()
        );
        const runtime = cards.find((card) => card.tag === 'runtime_segmentation_fault');
        assert.ok(runtime);
        assert.strictEqual(runtime.frequency, 2);
        assert.strictEqual(runtime.unresolvedCount, 2);
        assert.match(runtime.phenomenon ?? '', /退出码 3221225477/);
        assert.deepStrictEqual(runtime.concreteFixes, []);
    });

    it('手动解决按各自 problemKey 独立计算，新同题错误重置且 run_success 不翻转', () => {
        const mainOld = runError({
            id: 'main-old',
            timestamp: 1_000,
            kind: 'runtime_arithmetic_exception',
            fileUri: 'file:///w/main.exe',
        });
        const mainNew = runError({
            id: 'main-new',
            timestamp: 3_000,
            kind: 'runtime_arithmetic_exception',
            fileUri: 'file:///w/main.exe',
        });
        const task = runError({
            id: 'task-new',
            timestamp: 2_000,
            kind: 'runtime_arithmetic_exception',
            fileUri: 'file:///w/task.exe',
        });

        const stale = buildKnowledgeCardsFromEvents([mainOld, task, mainNew], {
            resolvedMarks: { main: 1_500, task: 2_500 },
        })[0];
        assert.strictEqual(stale.frequency, 3);
        assert.strictEqual(stale.resolvedCount, 1, 'task 的标记只解决 task occurrence');
        assert.strictEqual(stale.unresolvedCount, 2, 'main 新错让 main 旧标记整体失效');

        const successDoesNotFlip = buildKnowledgeCardsFromEvents(
            [mainOld, runSuccess({ timestamp: 9_000, fileUri: 'file:///w/main.exe' })],
            { resolvedMarks: { main: 1_500 } }
        )[0];
        assert.strictEqual(successDoesNotFlip.resolvedCount, 1);
        assert.strictEqual(successDoesNotFlip.unresolvedCount, 0);
    });

    it('多题同 kind 全局合并：统计不串标记，最新 occurrence 作代表；同时间用 event id 稳定破平', () => {
        const main = runError({
            id: 'run-a',
            timestamp: 4_000,
            kind: 'runtime_assertion_failed',
            fileUri: 'file:///w/main.exe',
            exitCode: 3,
        });
        const task = runError({
            id: 'run-z',
            timestamp: 4_000,
            kind: 'runtime_assertion_failed',
            fileUri: 'file:///w/task.exe',
            exitCode: 134,
        });

        const forward = buildKnowledgeCardsFromEvents([main, task], {
            resolvedMarks: { main: 5_000 },
        })[0];
        const reversed = buildKnowledgeCardsFromEvents([task, main], {
            resolvedMarks: { main: 5_000 },
        })[0];

        for (const card of [forward, reversed]) {
            assert.strictEqual(card.frequency, 2);
            assert.strictEqual(card.resolvedCount, 1);
            assert.strictEqual(card.unresolvedCount, 1);
            assert.strictEqual(card.problemKey, 'task');
            assert.strictEqual(card.fileUri, 'file:///w/task.exe');
            assert.match(card.phenomenon ?? '', /退出码 134/);
        }
    });

    it('store 入口读取 resolvedMarks，返回包含运行错误的统一卡片列表', async () => {
        const events: DebugEvent[] = [
            runError({
                id: 'stored-run',
                timestamp: 1_000,
                kind: 'runtime_stack_overflow',
            }),
        ];
        const store = {
            getEvents: async () => events,
            getResolvedMarks: async () => ({ main: 2_000 }),
        } as unknown as DebugJourneyStore;

        const cards = await buildKnowledgeCards(store);

        assert.strictEqual(cards.length, 1);
        assert.strictEqual(cards[0].tag, 'runtime_stack_overflow');
        assert.strictEqual(cards[0].resolvedCount, 1);
        assert.strictEqual(cards[0].unresolvedCount, 0);
    });
});
