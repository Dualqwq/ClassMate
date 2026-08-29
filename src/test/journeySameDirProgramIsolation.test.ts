import * as assert from 'assert';
import { describe, it } from 'mocha';
import { buildJourneyViewModel } from '../journey/journeyViewModel';
import type { JourneyEpisodeVM } from '../journey/journeyViewModel';
import {
    buildTimelineSections,
    collectFileOptions,
    EMPTY_FILTER,
} from '../journey/journeyFilters';
import { buildJourneyDigest } from '../chat/journeyDigestBuilder';
import type { CompileErrorEvent, DebugEvent, RunErrorEvent } from '../debug/types';

/**
 * 同目录两源文件各自编译运行的全层隔离回归(2026-08-29,Bug 3 锚定)。
 *
 * 场景:同一目录下 a.cpp 与 b.cpp 两个独立程序,各自「编译失败 + 运行出错」。
 * 事件形态还原真实数据(2026-08-29 events.jsonl):compile 事件 fileUri 是
 * file:// URI 而 parsed.file 是普通 Windows 路径;run 事件 fileUri 是 exe 的
 * URI、sourceFileUri 归位源文件。无题目材料(question.md/PDF)时不落
 * problemKey 字段,消费方按文件名 stem 回退。
 *
 * 排查结论(证据链见提交说明):时间线卡内条目、文件筛选、编译错题卡归属、
 * digest 相关度四层在真实与全场景数据下均按程序隔离,不存在跨文件串扰;
 * 用户可见的「串」来自文件下拉把同一程序识别成两个选项(Bug 1,已在
 * collectFileOptions 收敛修复)。本文件把这些隔离保证固化为回归锚定,并
 * 显式锚定两个「合法 problemKey 聚合层」的既定设计边界(见对应用例注释),
 * 防止未来改动在无意识中破坏或误判它们。
 */

const BASE = 1_700_000_000_000;
const A_CPP_URI = 'file:///c%3A/ws/a.cpp';
const A_EXE_URI = 'file:///c%3A/ws/a.exe';
const B_CPP_URI = 'file:///c%3A/ws/b.cpp';
const B_EXE_URI = 'file:///c%3A/ws/b.exe';

function scenarioCompileError(stem: 'a' | 'b', timestamp: number, problemKey?: string): CompileErrorEvent {
    return {
        id: `${stem}-err`,
        type: 'compile_error',
        timestamp,
        sessionId: 'session-a-b',
        workspaceId: 'ws-same-dir',
        fileUri: stem === 'a' ? A_CPP_URI : B_CPP_URI,
        stderr:
            stem === 'a'
                ? 'a.cpp:1:10: fatal error: bits/stdc+.h: No such file or directory'
                : "b.cpp:4:19: error: no match for 'operator<<' (operand types are 'std::basic_ostream<char>' and '<unresolved overloaded function type>')",
        parsedErrors: [
            {
                raw:
                    stem === 'a'
                        ? 'a.cpp:1:10: fatal error: bits/stdc+.h: No such file or directory'
                        : "b.cpp:4:19: error: no match for 'operator<<' (operand types are 'std::basic_ostream<char>' and '<unresolved overloaded function type>')",
                file: `c:\\ws\\${stem}.cpp`,
                line: stem === 'a' ? 1 : 4,
                column: stem === 'a' ? 10 : 19,
                severity: 'error',
                message:
                    stem === 'a'
                        ? 'bits/stdc+.h: No such file or directory'
                        : "no match for 'operator<<' (operand types are 'std::basic_ostream<char>' and '<unresolved overloaded function type>')",
            },
        ],
        exitCode: 1,
        durationMs: 800,
        ...(problemKey !== undefined ? { problemKey } : {}),
    };
}

function scenarioRunError(stem: 'a' | 'b', timestamp: number, problemKey?: string): RunErrorEvent {
    return {
        id: `${stem}-run`,
        type: 'run_error',
        timestamp,
        sessionId: 'session-a-b',
        workspaceId: 'ws-same-dir',
        fileUri: stem === 'a' ? A_EXE_URI : B_EXE_URI,
        executablePath: `c:\\ws\\${stem}.exe`,
        stdout: '',
        stderr:
            stem === 'a'
                ? 'integer division by zero'
                : 'integer division by zero',
        exitCode: 3221225501,
        durationMs: 120,
        kind: 'runtime_arithmetic_exception',
        sourceFileUri: stem === 'a' ? A_CPP_URI : B_CPP_URI,
        ...(problemKey !== undefined ? { problemKey } : {}),
    };
}

/** 无材料键(真实形态):problemKey 派生回退文件名 stem。 */
function scenarioEvents(): DebugEvent[] {
    return [
        scenarioCompileError('a', BASE),
        scenarioRunError('a', BASE + 10_000),
        scenarioCompileError('b', BASE + 60_000),
        scenarioRunError('b', BASE + 70_000),
    ];
}

/** 材料键世界:四个事件同落一题(problemKey='两数之和'),验证合法聚合层边界。 */
function scenarioEventsWithMaterialKey(): DebugEvent[] {
    return [
        scenarioCompileError('a', BASE, '两数之和'),
        scenarioRunError('a', BASE + 10_000, '两数之和'),
        scenarioCompileError('b', BASE + 60_000, '两数之和'),
        scenarioRunError('b', BASE + 70_000, '两数之和'),
    ];
}

function findEpisode(view: { episodes: JourneyEpisodeVM[] }, errorEventId: string): JourneyEpisodeVM {
    const episode = view.episodes.find((e) => e.errorEventId === errorEventId);
    assert.ok(episode, `episode ${errorEventId} 应存在`);
    return episode;
}

function flattenSectionEpisodes(sections: ReturnType<typeof buildTimelineSections>): JourneyEpisodeVM[] {
    return [...sections.unresolved, ...sections.byDay.flatMap((group) => group.episodes)];
}

describe('同目录两源文件各自编译运行:全层隔离回归(2026-08-29 Bug 3 锚定)', () => {
    it('时间线卡内条目按程序隔离:a 卡只并 a 的运行,b 卡只并 b 的运行,条目晚→早', () => {
        const view = buildJourneyViewModel(scenarioEvents());

        const cardA = findEpisode(view, 'a-err');
        assert.deepStrictEqual(
            cardA.entries.map((entry) => entry.eventId),
            ['a-run', 'a-err'],
            'a.cpp 编译卡条目 = 本程序的 run + compile,降序,无 b 侧条目'
        );
        const cardB = findEpisode(view, 'b-err');
        assert.deepStrictEqual(
            cardB.entries.map((entry) => entry.eventId),
            ['b-run', 'b-err'],
            'b.cpp 编译卡条目 = 本程序的 run + compile,降序,无 a 侧条目'
        );

        // 独立 run 卡:fileUri 按sourceFileUri 归位源文件,problemKey 按 stem 各自归属。
        const runA = findEpisode(view, 'a-run');
        assert.strictEqual(runA.fileUri, A_CPP_URI);
        assert.strictEqual(runA.problemKey, 'a');
        assert.strictEqual(runA.fileName, 'a.cpp');
        const runB = findEpisode(view, 'b-run');
        assert.strictEqual(runB.fileUri, B_CPP_URI);
        assert.strictEqual(runB.problemKey, 'b');
        assert.strictEqual(runB.fileName, 'b.cpp');

        // 全视图:任何卡条目流里都不出现对面程序的 run 条目。
        for (const episode of view.episodes) {
            const entryIds = episode.entries.map((entry) => entry.eventId);
            if (episode.errorEventId.startsWith('a')) {
                assert.ok(!entryIds.includes('b-run'), 'a 侧卡不得混入 b-run');
            }
            if (episode.errorEventId.startsWith('b')) {
                assert.ok(!entryIds.includes('a-run'), 'b 侧卡不得混入 a-run');
            }
            for (let i = 1; i < episode.entries.length; i++) {
                assert.ok(
                    episode.entries[i - 1].timestamp >= episode.entries[i].timestamp,
                    '卡内条目应保持晚→早'
                );
            }
        }
    });

    it('文件下拉收敛为 a.cpp/b.cpp 两项,任一选项(含编译卡的普通路径形态)过滤只见本程序', () => {
        const view = buildJourneyViewModel(scenarioEvents());

        const options = collectFileOptions(view);
        assert.deepStrictEqual(
            options.map((option) => option.label),
            ['a.cpp', 'b.cpp'],
            '同一程序(b.cpp↔b.exe)收敛为一个选项(Bug 1 修复锚定)'
        );
        assert.deepStrictEqual(
            options.map((option) => option.value),
            [A_CPP_URI, B_CPP_URI],
            '选项值统一为 file:// URI 形态'
        );

        for (const option of options) {
            const visible = flattenSectionEpisodes(
                buildTimelineSections(view, { ...EMPTY_FILTER, file: option.value })
            );
            const ids = visible.map((episode) => episode.errorEventId).sort();
            const expected = option.value === A_CPP_URI ? ['a-err', 'a-run'] : ['b-err', 'b-run'];
            assert.deepStrictEqual(ids, expected, `筛 ${option.label} 只见本程序的两张卡`);
        }

        // 编译卡 fileUri 是普通路径(parsed.file);按该形态筛选也走同一 stem 桶。
        const visibleByPath = flattenSectionEpisodes(
            buildTimelineSections(view, { ...EMPTY_FILTER, file: 'c:\\ws\\a.cpp' })
        );
        assert.deepStrictEqual(
            visibleByPath.map((episode) => episode.errorEventId).sort(),
            ['a-err', 'a-run']
        );
    });

    it('错题本编译卡按文件各自归属:missing_header→a、stream_output_operator→b,problemKey 不互串', () => {
        const view = buildJourneyViewModel(scenarioEvents());

        const missingHeader = view.mistakeCards.find((card) => card.tag === 'missing_header');
        assert.ok(missingHeader, 'a.cpp 的头文件缺失错题卡应存在');
        assert.strictEqual(missingHeader.problemKey, 'a');
        assert.ok(missingHeader.fileUri?.includes('a.cpp'), `归属 a.cpp,实际 ${missingHeader.fileUri}`);
        assert.strictEqual(missingHeader.frequency, 1);

        const streamOp = view.mistakeCards.find((card) => card.tag === 'stream_output_operator');
        assert.ok(streamOp, 'b.cpp 的输出运算符错题卡应存在');
        assert.strictEqual(streamOp.problemKey, 'b');
        assert.ok(streamOp.fileUri?.includes('b.cpp'), `归属 b.cpp,实际 ${streamOp.fileUri}`);
        assert.strictEqual(streamOp.frequency, 1);
    });

    it('设计边界锚定:运行错题卡按标签全局合并(frequency=2,problemKey 取最近一次现象)', () => {
        // mergeKnowledgeCards 是标签级合并;run 错题卡的 problemKey/定位取最近
        // 一次运行现象(journeyViewModel.ts「P1 不扩张成分题多卡」的既定裁剪)。
        // 本用例锚定现状:若未来改成分题多卡,这里需有意识地同步更新。
        const view = buildJourneyViewModel(scenarioEvents());

        const runCard = view.mistakeCards.find((card) => card.tag === 'runtime_arithmetic_exception');
        assert.ok(runCard, '两次 run_error 同分类应合并为一张卡');
        assert.strictEqual(runCard.frequency, 2);
        assert.strictEqual(runCard.problemKey, 'b', 'problemKey 取最近一次(b-run)的题目键');
        assert.ok(runCard.fileUri?.includes('b.cpp'), '定位取最近一次现象的文件');
    });

    it('run_error 手动解决按题目粒度:stem 世界标记 a 只解决 a,不影响 b 与编译卡', () => {
        const view = buildJourneyViewModel(scenarioEvents(), {
            resolvedMarks: { a: BASE + 15_000 },
        });

        const runA = findEpisode(view, 'a-run');
        assert.strictEqual(runA.resolved, true);
        assert.strictEqual(runA.resolvedByStudent, true);
        assert.strictEqual(runA.resolvedAt, BASE + 15_000);

        const runB = findEpisode(view, 'b-run');
        assert.strictEqual(runB.resolved, false, 'b 的 run 卡不得被 a 的标记波及');
        assert.notStrictEqual(runB.resolvedByStudent, true);

        // 编译卡解决态由生命周期判定(后续同文件编译),不受手动标记影响。
        for (const compileId of ['a-err', 'b-err']) {
            const card = findEpisode(view, compileId);
            assert.strictEqual(card.resolved, false, `${compileId} 的解决态不随 run 标记翻转`);
        }
    });

    it('设计边界锚定:材料键同题世界,解决标记按题共享且同题再犯即回退(合法聚合层语义)', () => {
        // problemKey 粒度的解决态由产品拍板(2026-08-24):标记只在该题没有
        // 更新的 run_error 时有效。同题两文件(a.cpp/b.cpp 同落「两数之和」)
        // 的运行解决态共享,属 problemKey 聚合层的合法语义,不是跨文件串扰缺陷。
        const beforeRecurrence = buildJourneyViewModel(scenarioEventsWithMaterialKey(), {
            resolvedMarks: { 两数之和: BASE + 15_000 },
        });
        for (const runId of ['a-run', 'b-run']) {
            assert.strictEqual(
                findEpisode(beforeRecurrence, runId).resolved,
                false,
                '标记早于同题更新的 run_error(b-run):再犯回退,两张卡都未解决'
            );
        }

        const afterRecurrence = buildJourneyViewModel(scenarioEventsWithMaterialKey(), {
            resolvedMarks: { 两数之和: BASE + 80_000 },
        });
        for (const runId of ['a-run', 'b-run']) {
            assert.strictEqual(
                findEpisode(afterRecurrence, runId).resolved,
                true,
                '标记晚于同题全部 run_error:同题两张卡一起解决'
            );
        }
    });

    it('digest 相关度按文件隔离:当前文件 a.cpp 时 a 的记录排前(stem 世界)', () => {
        const digest = buildJourneyDigest(scenarioEvents(), {
            currentFilePath: A_CPP_URI,
            nowMs: BASE + 200_000,
        });

        assert.ok(digest.includes('a.cpp'), 'digest 应包含 a.cpp 的记录');
        assert.ok(digest.includes('b.cpp'), 'digest 应包含 b.cpp 的记录');
        assert.ok(
            digest.indexOf('a.cpp') < digest.indexOf('b.cpp'),
            '当前文件 a.cpp 的条目应先于 b.cpp 出现(相关度优先)'
        );
    });

    it('digest 相关度在材料键同题世界仍按文件排前(不因同题键而失序)', () => {
        // 材料键同题不稀释 digest 相关度:markRelevant 对题目键不命中时回退
        // URI stem,当前文件侧条目依旧排前——同题聚合只发生在错题本分组层。
        const digest = buildJourneyDigest(scenarioEventsWithMaterialKey(), {
            currentFilePath: A_CPP_URI,
            nowMs: BASE + 200_000,
        });

        assert.ok(digest.includes('a.cpp'));
        assert.ok(digest.includes('b.cpp'));
        assert.ok(
            digest.indexOf('a.cpp') < digest.indexOf('b.cpp'),
            '同题材料键下 digest 仍应按当前文件相关度排序'
        );
    });
});
