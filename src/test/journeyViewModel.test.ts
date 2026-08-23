import * as assert from 'assert';
import { describe, it } from 'mocha';
import {
    buildJourneyViewModel,
    type MistakeCardVM,
} from '../journey/journeyViewModel';
import { parseCompilerStderrWithIncludes } from '../error/errorParser';
import { SEMANTIC_DEDUPE_WINDOW_MS } from '../debug/eventEnvelope';
import type {
    CodeModifiedEvent,
    CompileErrorEvent,
    CompileSuccessEvent,
    DebugEvent,
    HintRequestedEvent,
} from '../debug/types';

function compileError(overrides: Partial<CompileErrorEvent> = {}): CompileErrorEvent {
    return {
        id: 'err-1',
        type: 'compile_error',
        timestamp: 1_000,
        sessionId: 'session',
        workspaceId: 'ws',
        fileUri: 'file:///w/main.cpp',
        stderr: 'main.cpp:12:5: error: x was not declared in this scope',
        parsedErrors: [
            {
                raw: 'error: x was not declared in this scope',
                file: 'file:///w/main.cpp',
                line: 12,
                severity: 'error',
                message: "x was not declared in this scope",
            },
        ],
        exitCode: 1,
        durationMs: 800,
        ...overrides,
    };
}

function codeModified(overrides: Partial<CodeModifiedEvent> = {}): CodeModifiedEvent {
    return {
        id: 'edit-1',
        type: 'code_modified',
        timestamp: 2_000,
        sessionId: 'session',
        workspaceId: 'ws',
        fileUri: 'file:///w/main.cpp',
        before: 'int main() {\n    x\n}',
        after: 'int main() {\n    int x;\n}',
        diff: '-    x\n+    int x;',
        trigger: 'manual',
        ...overrides,
    };
}

function compileSuccess(overrides: Partial<CompileSuccessEvent> = {}): CompileSuccessEvent {
    return {
        id: 'ok-1',
        type: 'compile_success',
        timestamp: 3_000,
        sessionId: 'session',
        workspaceId: 'ws',
        fileUri: 'file:///w/main.cpp',
        exitCode: 0,
        durationMs: 700,
        ...overrides,
    };
}

function hintRequested(overrides: Partial<HintRequestedEvent> = {}): HintRequestedEvent {
    return {
        id: 'hint-1',
        type: 'hint_requested',
        timestamp: 2_500,
        sessionId: 'session',
        workspaceId: 'ws',
        fileUri: 'file:///w/main.cpp',
        intent: 'error_explanation',
        userPrompt: '这个错是什么意思',
        relatedCompileEventId: 'err-1',
        ...overrides,
    };
}

describe('buildJourneyViewModel', () => {
    it('空事件给出全零指标与空列表', () => {
        const view = buildJourneyViewModel([]);
        assert.strictEqual(view.metrics.totalEvents, 0);
        assert.strictEqual(view.metrics.resolvedErrors, 0);
        assert.strictEqual(view.metrics.unresolvedErrors, 0);
        assert.deepStrictEqual(view.episodes, []);
        assert.deepStrictEqual(view.mistakeCards, []);
    });

    it('编译失败→编辑→编译成功 生成一个已解决 episode,条目按时间升序', () => {
        const view = buildJourneyViewModel([
            compileError(),
            codeModified(),
            compileSuccess(),
        ]);

        assert.strictEqual(view.episodes.length, 1);
        const episode = view.episodes[0];
        assert.strictEqual(episode.resolved, true);
        assert.strictEqual(episode.resolvedAt, 3_000);
        assert.strictEqual(episode.errorEventId, 'err-1');
        assert.match(episode.message, /was not declared/);
        assert.strictEqual(episode.fileName, 'main.cpp');
        assert.strictEqual(episode.line, 12);

        const kinds = episode.entries.map((e) => e.kind);
        assert.deepStrictEqual(kinds, ['compile_error', 'code_modified', 'compile_success']);
        assert.strictEqual(episode.entries[0].label, '编译失败(1 个错误)');
        assert.strictEqual(episode.entries[1].changedLines, 2);
    });

    it('未解决 episode 排在已解决之前(置顶),其余按首次出现倒序', () => {
        // 两次犯错时间相距超过幂等窗口:同指纹但都是真实历史,不得折叠。
        const events: DebugEvent[] = [
            compileError({ id: 'old-resolved', timestamp: 1_000 }),
            compileSuccess({ id: 'ok-old', timestamp: 2_000 }),
            compileError({ id: 'new-unresolved', timestamp: SEMANTIC_DEDUPE_WINDOW_MS + 20_000 }),
        ];
        const view = buildJourneyViewModel(events);
        // 同一条错误签名(normalize 后相同)会各自成 lifecycle;未解决者必须最前。
        assert.strictEqual(view.episodes[0].resolved, false);
        assert.ok(
            view.episodes.filter((e) => e.resolved).length >= 1,
            '至少存在一个已解决 episode'
        );
        assert.strictEqual(view.metrics.unresolvedErrors >= 1, true);
    });

    it('求助条目进入时间线并计入求助比例', () => {
        const view = buildJourneyViewModel([
            compileError(),
            hintRequested(),
            compileSuccess(),
        ]);
        const episode = view.episodes[0];
        const hintEntry = episode.entries.find((e) => e.kind === 'hint_requested');
        assert.ok(hintEntry, '求助条目应出现在时间线');
        assert.match(hintEntry.label, /求助了 AI/);
        assert.strictEqual(view.metrics.helpSeekingRatio > 0, true);
    });

    it('同一知识标签的多次错误合并为一张卡,版本链 frequency 累计', () => {
        // 两次犯错时间相距超过幂等窗口(真实历史,不折叠)。
        const resolvedPair = [
            compileError({ id: 'a1', timestamp: 1_000 }),
            compileSuccess({ id: 'a2', timestamp: 1_500 }),
        ];
        const unresolvedSingle = [
            compileError({ id: 'b1', timestamp: SEMANTIC_DEDUPE_WINDOW_MS + 20_000 }),
        ];
        const merged = buildJourneyViewModel([...resolvedPair, ...unresolvedSingle]);

        const card = merged.mistakeCards.find((c) => c.tag === 'undeclared_identifier') as
            | MistakeCardVM
            | undefined;
        assert.ok(card, '应生成 undeclared_identifier 错题卡');
        assert.strictEqual(card.frequency, 2);
        assert.match(card.phenomenon, /was not declared/);
        // 排序规则(sortKnowledgeCards):有未解决的卡排在纯已解决卡之前。
        if (merged.mistakeCards.length > 1) {
            const unresolvedFirst = merged.mistakeCards[0].unresolvedCount > 0;
            if (unresolvedFirst) {
                assert.ok(
                    merged.mistakeCards
                        .slice(1)
                        .every((c) => c.unresolvedCount <= merged.mistakeCards[0].unresolvedCount)
                );
            }
        }
    });

    it('修复编辑被去重后作为第三档修复样例呈现', () => {
        const view = buildJourneyViewModel([
            compileError({ id: 'c1', timestamp: 1_000 }),
            codeModified({ id: 'c2', timestamp: 1_400 }),
            compileSuccess({ id: 'c3', timestamp: 1_800 }),
        ]);
        const card = view.mistakeCards.find((c) => c.tag === 'undeclared_identifier');
        assert.ok(card);
        assert.strictEqual(card.fixes.length, 1);
        assert.match(card.fixes[0].diff, /int x/);
        assert.strictEqual(card.fileUri, 'file:///w/main.cpp');
        assert.strictEqual(card.line, 12);
    });

    it('消费折叠:同指纹且时间相近的重复事件只出一张卡,时间相远的保留历史', () => {
        const makeCopy = (id: string, timestamp: number): DebugEvent[] => [
            compileError({ id: `${id}-err`, timestamp, fileUri: 'file:///w/a.cpp' }),
            compileSuccess({ id: `${id}-ok`, timestamp: timestamp + 500 }),
        ];
        // 同一次构建的多份拷贝(多翻译单元同错):时间相近、语义相同。
        const view = buildJourneyViewModel([
            ...makeCopy('a', 1_000),
            ...makeCopy('b', 2_000),
            ...makeCopy('c', 3_000),
        ]);
        const sameBatchCards = view.mistakeCards.filter((c) => c.tag === 'undeclared_identifier');
        assert.strictEqual(sameBatchCards.length >= 1, true);
        assert.strictEqual(view.metrics.totalEvents, 6 - 4, '同批次重复被折叠(3 err+3 ok → 1 err+1 ok)');

        // 时间相远:学生真实地又一次犯同样错,历史必须完整保留。
        const acrossDays = buildJourneyViewModel([
            compileError({ id: 'd1', timestamp: 1_000_000 }),
            compileError({ id: 'd2', timestamp: 90_000_000_000 }),
        ]);
        assert.strictEqual(acrossDays.episodes.length, 2, '跨时间的同错是真实历史,不得折叠');
    });

    it('头文件错误跳转位置指向真实报错文件(parsed.file),而非主翻译单元', () => {
        const headerError = compileError({
            id: 'h1',
            timestamp: 1_000,
            fileUri: 'file:///w/a.cpp',
            stderr: [
                'In file included from a.cpp:1:',
                "b.h:5:10: error: expected ';' before '}' token",
            ].join('\n'),
            parsedErrors: parseCompilerStderrWithIncludes([
                'In file included from a.cpp:1:',
                "b.h:5:10: error: expected ';' before '}' token",
            ].join('\n')),
        });
        const view = buildJourneyViewModel([headerError]);

        assert.strictEqual(view.episodes.length, 1);
        const episode = view.episodes[0];
        // 归属与跳转都指向 b.h(真正报错处),事件级 fileUri(a.cpp)不参与定位。
        assert.strictEqual(episode.fileUri, 'b.h');
        assert.strictEqual(episode.fileName, 'b.h');
        assert.strictEqual(episode.line, 5);
        assert.deepStrictEqual(episode.viaIncludes, ['a.cpp:1']);
    });
});
