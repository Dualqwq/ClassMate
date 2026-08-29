import * as assert from 'assert';
import { describe, it } from 'mocha';
import { buildJourneyViewModel } from '../journey/journeyViewModel';
import type { JourneyEpisodeVM } from '../journey/journeyViewModel';
import {
    buildTimelineSections,
    collectFileOptions,
    EMPTY_FILTER,
} from '../journey/journeyFilters';
import type { CompileErrorEvent, DebugEvent, RunErrorEvent } from '../debug/types';

/**
 * 跨目录同名文件全层隔离回归(2026-08-29 用户实测「problem1/a.cpp 与
 * problem2/a.cpp 分不开」锚定)。
 *
 * 场景:工作区 c:\ws 下 problem1/a.cpp 与 problem2/a.cpp 是两个独立程序,
 * 各自「编译失败 + 运行出错」。事件形态还原真实数据:compile 事件 fileUri
 * 是 percent 编码 file:// URI 而 parsed.file 是纯 Windows 路径;problem1 的
 * run 是旧形态(只有 exe fileUri、无 sourceFileUri),problem2 的 run 是
 * 新形态(sourceFileUri 归位源文件)。无题目材料(question.md)→ stem 世界,
 * 两侧都无 problemKey。
 *
 * 修复前:collectFileOptions 按 deriveProblemKey 裸 stem 收敛(两个 a.cpp
 * 并成一个选项)、fileMatchesEpisode 裸 stem 等值(任一方向筛选互串)、
 * journeyViewModel 编译卡归并裸 stem 等值(problem2 的 run 条目灌进
 * problem1 的编译卡)。修复口径:带目录限定的「同一程序」判定
 * (src/debug/fileIdentity.ts sameProgramFile),同目录 a.cpp↔a.exe 语义
 * 保全(journeySameDirProgramIsolation.test.ts 原语义零修改通过)。
 */

const ROOT = 'c:\\ws';
const P1_CPP_URI = 'file:///c%3A/ws/problem1/a.cpp';
const P1_EXE_URI = 'file:///c%3A/ws/problem1/a.exe';
const P2_CPP_URI = 'file:///c%3A/ws/problem2/a.cpp';
const P2_EXE_URI = 'file:///c%3A/ws/problem2/a.exe';
const BASE = 1_700_000_000_000;

function compileErrorEvent(problem: 'problem1' | 'problem2', timestamp: number): CompileErrorEvent {
    return {
        id: `${problem}-err`,
        type: 'compile_error',
        timestamp,
        sessionId: 'session-cross-dir',
        workspaceId: 'ws-cross-dir',
        fileUri: problem === 'problem1' ? P1_CPP_URI : P2_CPP_URI,
        stderr:
            problem === 'problem1'
                ? 'a.cpp:3:5: error: x was not declared in this scope'
                : 'a.cpp:7:9: error: expected \';\' before \'}\' token',
        parsedErrors: [
            {
                raw:
                    problem === 'problem1'
                        ? 'a.cpp:3:5: error: x was not declared in this scope'
                        : 'a.cpp:7:9: error: expected \';\' before \'}\' token',
                // 解析诊断行剥出的纯 Windows 路径(真实形态:含题目子目录)。
                file: `c:\\ws\\${problem}\\a.cpp`,
                line: problem === 'problem1' ? 3 : 7,
                column: problem === 'problem1' ? 5 : 9,
                severity: 'error',
                message:
                    problem === 'problem1'
                        ? 'x was not declared in this scope'
                        : "expected ';' before '}' token",
            },
        ],
        exitCode: 1,
        durationMs: 800,
    };
}

/** 旧形态 run(无 sourceFileUri):fileUri 只有 exe。 */
function legacyRunErrorEvent(problem: 'problem1', timestamp: number): RunErrorEvent {
    return {
        id: `${problem}-run`,
        type: 'run_error',
        timestamp,
        sessionId: 'session-cross-dir',
        workspaceId: 'ws-cross-dir',
        fileUri: P1_EXE_URI,
        executablePath: 'c:\\ws\\problem1\\a.exe',
        stdout: '',
        stderr: 'Segmentation fault (core dumped)',
        exitCode: 139,
        durationMs: 90,
        kind: 'runtime_segmentation_fault',
    };
}

/** 新形态 run(sourceFileUri 归位源文件)。 */
function runErrorEvent(problem: 'problem2', timestamp: number): RunErrorEvent {
    return {
        id: `${problem}-run`,
        type: 'run_error',
        timestamp,
        sessionId: 'session-cross-dir',
        workspaceId: 'ws-cross-dir',
        fileUri: P2_EXE_URI,
        executablePath: 'c:\\ws\\problem2\\a.exe',
        sourceFileUri: P2_CPP_URI,
        stdout: '',
        stderr: 'integer division by zero',
        exitCode: 3221225501,
        durationMs: 90,
        kind: 'runtime_arithmetic_exception',
    };
}

function scenarioEvents(): DebugEvent[] {
    return [
        compileErrorEvent('problem1', BASE),
        legacyRunErrorEvent('problem1', BASE + 10_000),
        compileErrorEvent('problem2', BASE + 60_000),
        runErrorEvent('problem2', BASE + 70_000),
    ];
}

function findEpisode(view: { episodes: JourneyEpisodeVM[] }, errorEventId: string): JourneyEpisodeVM {
    const episode = view.episodes.find((e) => e.errorEventId === errorEventId);
    assert.ok(episode, `episode ${errorEventId} 应存在`);
    return episode;
}

function flattenIds(sections: ReturnType<typeof buildTimelineSections>): string[] {
    return [
        ...sections.unresolved,
        ...sections.byDay.flatMap((group) => group.episodes),
    ].map((e) => e.errorEventId);
}

describe('跨目录同名文件(problem1/a.cpp vs problem2/a.cpp)全层隔离', () => {
    it('编译卡条目按程序隔离:problem1 编译卡只并 problem1 的运行,problem2 同理', () => {
        const view = buildJourneyViewModel(scenarioEvents());

        const cardP1 = findEpisode(view, 'problem1-err');
        assert.deepStrictEqual(
            cardP1.entries.map((entry) => entry.eventId),
            ['problem1-run', 'problem1-err'],
            'problem1 编译卡 = 本程序 run + compile,problem2 的 run 不得混入'
        );
        const cardP2 = findEpisode(view, 'problem2-err');
        assert.deepStrictEqual(
            cardP2.entries.map((entry) => entry.eventId),
            ['problem2-run', 'problem2-err'],
            'problem2 编译卡 = 本程序 run + compile,problem1 的 run 不得混入'
        );
    });

    it('文件下拉两个选项:label 为工作区相对路径且互不相同,value 各归各程序', () => {
        const view = buildJourneyViewModel(scenarioEvents(), { workspaceRoot: ROOT });
        const options = collectFileOptions(view);

        assert.deepStrictEqual(
            options.map((option) => option.label),
            ['problem1/a.cpp', 'problem2/a.cpp'],
            'label 为工作区相对路径(正斜杠)且跨目录同名文件分开'
        );
        // problem1 的桶由旧形态 run(exe file://)先建桶、label 被编译卡
        // 源文件形态接管;value 优先 file:// 形态。
        assert.deepStrictEqual(
            options.map((option) => option.value),
            [P1_EXE_URI, P2_CPP_URI],
            '选项值优先 file:// 形态:problem1 桶=旧事件 exe URI,problem2 桶=归位源文件 URI'
        );
    });

    it('任一方向筛选互不串:两个选项值(含 exe URI)各自只见本程序的两张卡', () => {
        const view = buildJourneyViewModel(scenarioEvents(), { workspaceRoot: ROOT });
        const options = collectFileOptions(view);

        for (const option of options) {
            const ids = flattenIds(
                buildTimelineSections(view, { ...EMPTY_FILTER, file: option.value })
            ).sort();
            const expected =
                option.value === P1_EXE_URI
                    ? ['problem1-err', 'problem1-run']
                    : ['problem2-err', 'problem2-run'];
            assert.deepStrictEqual(ids, expected, `筛 ${option.label} 只见本程序的两张卡`);
        }

        // 编译卡的纯路径形态(parsed.file)与源文件 URI 双向筛选也不串。
        for (const filterFile of ['c:\\ws\\problem1\\a.cpp', P1_CPP_URI]) {
            const ids = flattenIds(
                buildTimelineSections(view, { ...EMPTY_FILTER, file: filterFile })
            ).sort();
            assert.deepStrictEqual(
                ids,
                ['problem1-err', 'problem1-run'],
                `筛 ${filterFile} 不得带出 problem2 的条目`
            );
        }
        for (const filterFile of ['c:\\ws\\problem2\\a.cpp', P2_CPP_URI]) {
            const ids = flattenIds(
                buildTimelineSections(view, { ...EMPTY_FILTER, file: filterFile })
            ).sort();
            assert.deepStrictEqual(
                ids,
                ['problem2-err', 'problem2-run'],
                `筛 ${filterFile} 不得带出 problem1 的条目`
            );
        }
    });

    it('同目录 a.cpp↔a.exe 语义保全:筛 problem1 的 exe 仍能看到 problem1 的编译卡', () => {
        const view = buildJourneyViewModel(scenarioEvents(), { workspaceRoot: ROOT });
        const ids = flattenIds(
            buildTimelineSections(view, { ...EMPTY_FILTER, file: P1_EXE_URI })
        ).sort();
        assert.deepStrictEqual(
            ids,
            ['problem1-err', 'problem1-run'],
            '旧事件 exe URI 筛选与同目录源文件编译卡仍归并(FE3 设计语义)'
        );
    });

    it('视图模型下发工作区相对展示位置:卡头 fileLabel 区分两个 a.cpp', () => {
        const view = buildJourneyViewModel(scenarioEvents(), { workspaceRoot: ROOT });
        assert.strictEqual(view.workspaceRoot, ROOT);

        assert.strictEqual(findEpisode(view, 'problem1-err').fileLabel, 'problem1/a.cpp');
        assert.strictEqual(findEpisode(view, 'problem2-err').fileLabel, 'problem2/a.cpp');
        // 旧形态 run 卡(fileUri 回退 exe)展示 exe 的相对路径;新形态 run 卡
        // 归位源文件。
        assert.strictEqual(findEpisode(view, 'problem1-run').fileLabel, 'problem1/a.exe');
        assert.strictEqual(findEpisode(view, 'problem2-run').fileLabel, 'problem2/a.cpp');
    });

    it('根未知时 label 退回原名(已知残留:同名 label,但 value 与筛选仍互不串)', () => {
        const view = buildJourneyViewModel(scenarioEvents());
        assert.strictEqual(view.workspaceRoot, undefined);

        const options = collectFileOptions(view);
        assert.deepStrictEqual(
            options.map((option) => option.label).sort(),
            ['a.cpp', 'a.cpp'],
            '无根时两个选项 label 同名(退化场景,生产环境 JourneyService 恒有根)'
        );
        assert.deepStrictEqual(
            [...new Set(options.map((option) => option.value))].sort(),
            [P1_EXE_URI, P2_CPP_URI].sort(),
            'value 仍按完整身份区分'
        );
        // 筛选正确性不受 label 同名影响。
        const idsP1 = flattenIds(
            buildTimelineSections(view, { ...EMPTY_FILTER, file: P1_EXE_URI })
        ).sort();
        assert.deepStrictEqual(idsP1, ['problem1-err', 'problem1-run']);
        const idsP2 = flattenIds(
            buildTimelineSections(view, { ...EMPTY_FILTER, file: P2_CPP_URI })
        ).sort();
        assert.deepStrictEqual(idsP2, ['problem2-err', 'problem2-run']);
    });
});
