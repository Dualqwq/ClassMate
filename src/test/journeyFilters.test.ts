import * as assert from 'assert';
import { describe, it } from 'mocha';
import {
    buildTimelineSections,
    collectFileOptions,
    groupMistakeCards,
    sortMistakeCards,
    summarizeEpisodesBySeverity,
    EMPTY_FILTER,
    type JourneyFilterState,
    type MistakeCardGroup,
} from '../journey/journeyFilters';
import { buildJourneyViewModel } from '../journey/journeyViewModel';
import type { JourneyEpisodeVM, JourneyViewModel, MistakeCardVM } from '../journey/journeyViewModel';
import type {
    CompileErrorEvent,
    CodeModifiedEvent,
    CompileSuccessEvent,
    DebugEvent,
    RunErrorEvent,
} from '../debug/types';

const NOW = new Date('2026-08-22T12:00:00').getTime();

function episode(overrides: Partial<JourneyEpisodeVM>): JourneyEpisodeVM {
    return {
        errorEventId: 'e',
        message: 'msg',
        fileUri: 'file:///w/main.cpp',
        fileName: 'main.cpp',
        line: 1,
        firstSeenAt: NOW - 1_000,
        resolved: true,
        attemptsBeforeResolve: 1,
        entries: [
            {
                eventId: 'entry-compile',
                kind: 'compile_error',
                timestamp: NOW - 1_000,
                label: '编译失败(1 个错误)',
            },
            {
                eventId: 'entry-edit',
                kind: 'code_modified',
                timestamp: NOW - 900,
                label: '修改了代码',
                changedLines: 2,
            },
        ],
        ...overrides,
    };
}

function viewOf(episodes: JourneyEpisodeVM[]): JourneyViewModel {
    return {
        generatedAt: NOW,
        metrics: {
            totalEvents: episodes.length,
            resolvedErrors: 0,
            unresolvedErrors: 0,
            avgFixAttempts: 0,
            helpSeekingRatio: 0,
            independentFixRatio: 0,
        },
        episodes,
        mistakeCards: [],
    };
}

function mistakeCard(tag: string, lastSeenAt: number): MistakeCardVM {
    return {
        tag,
        title: tag,
        phenomenon: 'p',
        commonCauses: [],
        checkMethod: '',
        fixes: [],
        frequency: 1,
        resolvedCount: 0,
        unresolvedCount: 1,
        lastSeenAt,
    };
}

describe('journeyFilters (webview 本地过滤纯函数)', () => {
    it('未解决置顶,已解决按日折叠且组内倒序', () => {
        const today = NOW - 60_000;
        const yesterday = NOW - 86_400_000 - 3_600_000;
        const earlierToday = NOW - 120_000;
        const view = viewOf([
            episode({ errorEventId: 'r1', firstSeenAt: earlierToday }),
            episode({ errorEventId: 'u1', firstSeenAt: today, resolved: false }),
            episode({ errorEventId: 'r2', firstSeenAt: yesterday }),
            episode({ errorEventId: 'r0', firstSeenAt: today }),
        ]);

        const { unresolved, byDay } = buildTimelineSections(view, { ...EMPTY_FILTER }, NOW);
        assert.deepStrictEqual(
            unresolved.map((e) => e.errorEventId),
            ['u1']
        );
        assert.strictEqual(byDay.length, 2);
        assert.strictEqual(byDay[0].label, '今天');
        assert.deepStrictEqual(
            byDay[0].episodes.map((e) => e.errorEventId),
            ['r0', 'r1'],
            '同日内按首次出现倒序'
        );
        assert.strictEqual(byDay[1].label, '昨天');
    });

    it('条目类型过滤后没有条目的 episode 不显示;文件与只看未解决生效', () => {
        const view = viewOf([
            episode({ errorEventId: 'a' }),
            episode({
                errorEventId: 'b',
                fileUri: 'file:///w/util.cpp',
                fileName: 'util.cpp',
                resolved: false,
            }),
        ]);

        const noEdits: JourneyFilterState = { ...EMPTY_FILTER, types: ['compile_success'] };
        const empty = buildTimelineSections(viewOf(view.episodes), noEdits, NOW);
        assert.strictEqual(empty.unresolved.length + empty.byDay.reduce((n, g) => n + g.episodes.length, 0), 0);

        const fileFiltered = buildTimelineSections(
            view,
            { ...EMPTY_FILTER, file: 'file:///w/util.cpp' },
            NOW
        );
        const visibleIds = [
            ...fileFiltered.unresolved,
            ...fileFiltered.byDay.flatMap((g) => g.episodes),
        ].map((e) => e.errorEventId);
        assert.deepStrictEqual(visibleIds, ['b']);

        const unresolvedOnly = buildTimelineSections(
            view,
            { ...EMPTY_FILTER, unresolvedOnly: true },
            NOW
        );
        assert.strictEqual(unresolvedOnly.byDay.length, 0);
        assert.deepStrictEqual(
            unresolvedOnly.unresolved.map((e) => e.errorEventId),
            ['b']
        );
    });

    it('文件下拉去重收集全部出现过的文件并按名称排序', () => {
        const view = viewOf([
            episode({ fileUri: 'file:///w/b.cpp', fileName: 'b.cpp' }),
            episode({ fileUri: 'file:///w/a.cpp', fileName: 'a.cpp' }),
            episode({ fileUri: 'file:///w/b.cpp', fileName: 'b.cpp' }),
            episode({ fileUri: undefined }),
        ]);
        assert.deepStrictEqual(collectFileOptions(view), [
            { value: 'file:///w/a.cpp', label: 'a.cpp' },
            { value: 'file:///w/b.cpp', label: 'b.cpp' },
        ]);
    });

    it('级别过滤与类型/文件/未解决正交组合,汇总跟随可见集', () => {
        const view = viewOf([
            episode({ errorEventId: 'err-un', severity: 'error', resolved: false }),
            episode({ errorEventId: 'warn-un', severity: 'warning', resolved: false, firstSeenAt: NOW - 2_000 }),
            episode({ errorEventId: 'warn-ok', severity: 'warning' }),
        ]);

        // 只看错误:警告卡(含已解决)全部隐藏。
        const errorsOnly = buildTimelineSections(
            view,
            { ...EMPTY_FILTER, levels: ['error'] },
            NOW
        );
        const errorIds = [
            ...errorsOnly.unresolved,
            ...errorsOnly.byDay.flatMap((g) => g.episodes),
        ].map((e) => e.errorEventId);
        assert.deepStrictEqual(errorIds, ['err-un']);

        // 只看警告 + 只看未解决 正交:只剩 warn-un。
        const warningsUnresolved = buildTimelineSections(
            view,
            { ...EMPTY_FILTER, levels: ['warning'], unresolvedOnly: true },
            NOW
        );
        assert.deepStrictEqual(
            warningsUnresolved.unresolved.map((e) => e.errorEventId),
            ['warn-un']
        );

        // 全部级别:三张卡都可见;分级汇总跟随当前筛选。
        const all = buildTimelineSections(view, { ...EMPTY_FILTER }, NOW);
        const visibleAll = [...all.unresolved, ...all.byDay.flatMap((g) => g.episodes)];
        assert.strictEqual(visibleAll.length, 3);
        let summary = summarizeEpisodesBySeverity(visibleAll);
        assert.deepStrictEqual(summary, {
            resolved: 1,
            unresolved: 2,
            unresolvedErrors: 1,
            unresolvedWarnings: 1,
        });

        // 指标跟随筛选:切到「只看警告」后,未解决=1 且全是警告。
        const visibleWarnings = [
            ...warningsUnresolved.unresolved,
            ...warningsUnresolved.byDay.flatMap((g) => g.episodes),
        ];
        summary = summarizeEpisodesBySeverity(visibleWarnings);
        assert.deepStrictEqual(summary, {
            resolved: 0,
            unresolved: 1,
            unresolvedErrors: 0,
            unresolvedWarnings: 1,
        });
    });

    it('错题本排序:推荐序保持视图模型顺序,recent 按 lastSeenAt 倒序', () => {
        const cards = [
            mistakeCard('t1', 100),
            mistakeCard('t2', 300),
            mistakeCard('t3', 200),
        ];
        const recommended = sortMistakeCards(cards, 'recommended');
        assert.deepStrictEqual(recommended.map((c) => c.tag), ['t1', 't2', 't3']);
        const recent = sortMistakeCards(cards, 'recent');
        assert.deepStrictEqual(recent.map((c) => c.tag), ['t2', 't3', 't1']);
    });
});

describe('run 条目过滤(#12b)', () => {
    function runEpisode(
        id: string,
        kind: 'run_error' | 'run_success',
        overrides: Partial<JourneyEpisodeVM> = {}
    ): JourneyEpisodeVM {
        return episode({
            errorEventId: id,
            message: '运行',
            resolved: kind === 'run_success',
            severity: kind === 'run_success' ? 'info' : 'error',
            entries: [
                {
                    eventId: `${id}-entry`,
                    kind,
                    timestamp: NOW - 500,
                    label: kind === 'run_success' ? '运行成功 ✓' : '运行出错：数组越界(退出码 1)',
                    ...(kind === 'run_error'
                        ? { runErrorKind: 'runtime_array_out_of_bounds' as const }
                        : {}),
                },
            ],
            ...overrides,
        });
    }

    function flattenIds(sections: ReturnType<typeof buildTimelineSections>): string[] {
        return [
            ...sections.unresolved,
            ...sections.byDay.flatMap((g) => g.episodes),
        ].map((e) => e.errorEventId);
    }

    it('类型过滤:取消「运行出错」后独立 run_error 卡消失,run_success 不受影响', () => {
        const view = viewOf([
            runEpisode('re1', 'run_error'),
            runEpisode('rs1', 'run_success'),
        ]);
        const withoutRunError = buildTimelineSections(
            view,
            { ...EMPTY_FILTER, types: EMPTY_FILTER.types.filter((t) => t !== 'run_error') },
            NOW
        );
        assert.deepStrictEqual(flattenIds(withoutRunError), ['rs1']);
    });

    it('级别过滤:取消「信息」后 run_success 卡消失', () => {
        const view = viewOf([runEpisode('rs1', 'run_success')]);
        const withoutInfo = buildTimelineSections(
            view,
            { ...EMPTY_FILTER, levels: ['error', 'warning'] },
            NOW
        );
        assert.strictEqual(flattenIds(withoutInfo).length, 0);
    });

    it('分类过滤:只留数组越界时,段错误卡与嵌套段错误条目都被隐藏', () => {
        const segEpisode = runEpisode('seg-ep', 'run_error', {
            runErrorKind: 'runtime_segmentation_fault',
            entries: [
                {
                    eventId: 'seg-entry',
                    kind: 'run_error',
                    timestamp: NOW - 400,
                    label: '运行出错：非法内存访问(段错误)',
                    runErrorKind: 'runtime_segmentation_fault',
                },
            ],
        });
        const oobCompileEpisode = episode({
            errorEventId: 'compile-ep',
            firstSeenAt: NOW - 2_000,
            entries: [
                {
                    eventId: 'compile-entry',
                    kind: 'compile_error',
                    timestamp: NOW - 2_000,
                    label: '编译失败(1 个错误)',
                },
                {
                    eventId: 'nested-oob',
                    kind: 'run_error',
                    timestamp: NOW - 600,
                    label: '运行出错：数组越界',
                    runErrorKind: 'runtime_array_out_of_bounds',
                },
                {
                    eventId: 'nested-seg',
                    kind: 'run_error',
                    timestamp: NOW - 500,
                    label: '运行出错：非法内存访问(段错误)',
                    runErrorKind: 'runtime_segmentation_fault',
                },
            ],
        });
        const view = viewOf([segEpisode, oobCompileEpisode]);

        const oobOnly = buildTimelineSections(
            view,
            { ...EMPTY_FILTER, runErrorKinds: ['runtime_array_out_of_bounds'] },
            NOW
        );
        // 段错误独立卡被隐藏;编译卡保留但嵌套的段错误条目也被隐藏。
        assert.deepStrictEqual(flattenIds(oobOnly), ['compile-ep']);
        const keptCompile = [
            ...oobOnly.unresolved,
            ...oobOnly.byDay.flatMap((g) => g.episodes),
        ].find((e) => e.errorEventId === 'compile-ep');
        assert.ok(keptCompile);
        assert.ok(
            !keptCompile.entries.some((e) => e.runErrorKind === 'runtime_segmentation_fault')
        );
        assert.ok(keptCompile.entries.some((e) => e.runErrorKind === 'runtime_array_out_of_bounds'));
    });

    it('错题本分组:tag 模式一卡一组;problemKey 模式归并且未关联置底', () => {
        const cards: MistakeCardVM[] = [
            { ...mistakeCard('t1', 100), problemKey: 'main' },
            { ...mistakeCard('t2', 200), problemKey: 'main' },
            { ...mistakeCard('t3', 300), problemKey: undefined },
        ];
        const byTag = groupMistakeCards(cards, 'tag');
        assert.strictEqual(byTag.length, 3);
        assert.ok(byTag.every((g: MistakeCardGroup) => g.cards.length === 1));

        const byProblem = groupMistakeCards(cards, 'problemKey');
        assert.strictEqual(byProblem.length, 2);
        assert.deepStrictEqual(byProblem.map((g) => g.key), ['main', '']);
        assert.strictEqual(byProblem[0].label, 'main');
        assert.strictEqual(byProblem[0].cards.length, 2);
        assert.strictEqual(byProblem[1].label, '未关联题目');
        assert.strictEqual(byProblem[1].cards.length, 1);
    });
});

describe('文件筛选与跨程序归并(2026-08-29 实测修复)', () => {
    // FE3 遗留实测场景:同目录 a.cpp / b.cpp 共享同一题面材料(事件带同一
    // problemKey),各自编译出自己的 exe。run 条目归并必须按「程序」判定而
    // 不是「材料」:否则 b.exe 的运行条目会灌进 a.cpp 的编译卡,文件筛选
    // 因此串卡(筛 b.exe 却看到 a.cpp 的编译错误)。
    function compileErrorEvent(
        id: string,
        timestamp: number,
        fileUri: string,
        problemKey?: string
    ): CompileErrorEvent {
        return {
            id,
            type: 'compile_error',
            timestamp,
            sessionId: 'session',
            workspaceId: 'ws',
            fileUri,
            stderr: 'a.cpp:12:5: error: x was not declared in this scope',
            parsedErrors: [
                {
                    raw: 'error: x was not declared in this scope',
                    file: fileUri,
                    line: 12,
                    severity: 'error',
                    message: 'x was not declared in this scope',
                },
            ],
            exitCode: 1,
            durationMs: 800,
            ...(problemKey !== undefined ? { problemKey } : {}),
        };
    }

    function runErrorEvent(
        id: string,
        timestamp: number,
        fileUri: string,
        overrides: Partial<RunErrorEvent> = {}
    ): RunErrorEvent {
        return {
            id,
            type: 'run_error',
            timestamp,
            sessionId: 'session',
            workspaceId: 'ws',
            fileUri,
            executablePath: fileUri,
            stderr: 'Segmentation fault (core dumped)',
            exitCode: 139,
            durationMs: 90,
            kind: 'runtime_segmentation_fault',
            ...overrides,
        };
    }

    function flattenIds(sections: ReturnType<typeof buildTimelineSections>): string[] {
        return [
            ...sections.unresolved,
            ...sections.byDay.flatMap((g) => g.episodes),
        ].map((e) => e.errorEventId);
    }

    it('① 同目录两份源码共享题面材料:b.exe 运行条目不并进 a.cpp 编译卡,筛 b.exe 不见 a.cpp 编译条目', () => {
        const view = buildJourneyViewModel([
            compileErrorEvent('c-a', 1_000, 'file:///w/a.cpp', '两数之和'),
            runErrorEvent('r-b', 2_000, 'file:///w/b.exe', {
                sourceFileUri: 'file:///w/b.cpp',
                problemKey: '两数之和',
            }),
        ]);

        // 归并按程序判定:a.cpp 编译卡不再吸收 b.exe 的运行条目。
        const compileCard = view.episodes.find((e) => e.errorEventId === 'c-a');
        assert.ok(compileCard);
        assert.ok(
            !compileCard.entries.some((e) => e.kind === 'run_error'),
            'b.exe 的运行条目不得并进 a.cpp 编译卡'
        );

        // 筛 b.exe:只见 b 程序自己的独立运行卡,a.cpp 编译卡(及其全部条目)隐藏。
        const byB = buildTimelineSections(
            view,
            { ...EMPTY_FILTER, file: 'file:///w/b.exe' },
            NOW
        );
        assert.deepStrictEqual(flattenIds(byB), ['r-b']);

        // 对照:筛 a.cpp 只见 a 程序的编译卡,b 程序的运行卡隐藏。
        const byA = buildTimelineSections(
            view,
            { ...EMPTY_FILTER, file: 'file:///w/a.cpp' },
            NOW
        );
        assert.deepStrictEqual(flattenIds(byA), ['c-a']);
    });

    it('② a.cpp 编译 + a.exe 运行仍归并为一条时间线,筛 a.exe 能看到 a.cpp 编译条目', () => {
        const view = buildJourneyViewModel([
            compileErrorEvent('c-a', 1_000, 'file:///w/a.cpp', '两数之和'),
            runErrorEvent('r-a', 2_000, 'file:///w/a.exe', {
                sourceFileUri: 'file:///w/a.cpp',
                problemKey: '两数之和',
            }),
        ]);

        const compileCard = view.episodes.find((e) => e.errorEventId === 'c-a');
        assert.ok(compileCard);
        assert.ok(
            compileCard.entries.some((e) => e.kind === 'run_error'),
            '同一程序的运行条目仍镜像进编译卡条目流'
        );

        // 筛 a.exe(exe URI):同一程序的 a.cpp 编译卡可见(stem 感知),
        // 独立 run 卡(归位到 a.cpp)也可见;未解决区晚→早。
        const byExe = buildTimelineSections(
            view,
            { ...EMPTY_FILTER, file: 'file:///w/a.exe' },
            NOW
        );
        assert.deepStrictEqual(flattenIds(byExe), ['r-a', 'c-a']);
    });

    it('③ 旧事件(run 只有 exe fileUri、无归位字段)按 stem 归并不变,筛 a.exe 同样能看到 a.cpp 编译卡', () => {
        const view = buildJourneyViewModel([
            compileErrorEvent('c-a', 1_000, 'file:///w/a.cpp'),
            runErrorEvent('r-a', 2_000, 'file:///w/a.exe'),
        ]);

        const compileCard = view.episodes.find((e) => e.errorEventId === 'c-a');
        assert.ok(compileCard);
        assert.ok(
            compileCard.entries.some((e) => e.kind === 'run_error'),
            '旧事件按 stem 兜底归并,行为不变'
        );

        const byExe = buildTimelineSections(
            view,
            { ...EMPTY_FILTER, file: 'file:///w/a.exe' },
            NOW
        );
        assert.deepStrictEqual(flattenIds(byExe), ['r-a', 'c-a']);
    });
});

describe('文件下拉同一程序收敛为一个选项(2026-08-29 实测修复)', () => {
    // 用户实测:编译错误和运行错误都有的时候,文件下拉出现两个 b.cpp。
    // 根因:编译卡 fileUri 是解析诊断行里的报错文件(parsed.file,纯路径,
    // journeyViewModel 既有设计——头文件错误须指向真实报错文件),运行卡
    // fileUri 是事件自带的 sourceFileUri(percent 编码 URI);旧
    // collectFileOptions 按精确字符串去重,同一文件出两个同名 label 选项。
    // 修复口径:与 fileMatchesEpisode 的 stem 感知一致,同一程序收敛为
    // 一个选项;取值优先 file:// URI 形态,label 沿用 fileName。
    const B_SOURCE_URI = 'file:///w/%E6%99%BA%E7%90%86%E6%9D%AF/b.cpp';
    const B_EXE_URI = 'file:///w/%E6%99%BA%E7%90%86%E6%9D%AF/b.exe';

    function flattenIds(sections: ReturnType<typeof buildTimelineSections>): string[] {
        return [
            ...sections.unresolved,
            ...sections.byDay.flatMap((g) => g.episodes),
        ].map((e) => e.errorEventId);
    }

    function mixedFormView(): JourneyViewModel {
        return viewOf([
            // 编译卡:报错文件被解析器剥成纯 Windows 路径
            episode({
                errorEventId: 'c-b',
                fileUri: 'c:\\ws\\b.cpp',
                fileName: 'b.cpp',
                resolved: false,
            }),
            // 运行卡:源文件归位后的 percent 编码 URI
            episode({
                errorEventId: 'r-b',
                fileUri: B_SOURCE_URI,
                fileName: 'b.cpp',
                resolved: false,
            }),
            // 另一个程序 a.cpp(纯路径形态)
            episode({
                errorEventId: 'c-a',
                fileUri: 'c:\\ws\\a.cpp',
                fileName: 'a.cpp',
                resolved: false,
            }),
        ]);
    }

    it('① 编译卡纯路径与运行卡 URI 是同一文件:下拉只出一个 b.cpp', () => {
        assert.deepStrictEqual(collectFileOptions(mixedFormView()), [
            { value: 'c:\\ws\\a.cpp', label: 'a.cpp' },
            { value: B_SOURCE_URI, label: 'b.cpp' },
        ]);
    });

    it('② 收敛后任选一个 b.cpp 值,同程序的编译卡与运行卡都可见,a.cpp 不串入', () => {
        const view = mixedFormView();
        for (const value of ['c:\\ws\\b.cpp', B_SOURCE_URI]) {
            const sections = buildTimelineSections(
                view,
                { ...EMPTY_FILTER, file: value },
                NOW
            );
            assert.deepStrictEqual(
                flattenIds(sections).sort(),
                ['c-b', 'r-b'],
                `选 ${value} 应看到 b.cpp 编译卡 + 运行卡,不见 a.cpp`
            );
        }
    });

    it('③ 旧事件只有 exe URI 时与编译卡按 stem 收敛,label 保留源文件名', () => {
        const view = viewOf([
            episode({
                errorEventId: 'c-b',
                fileUri: 'c:\\ws\\b.cpp',
                fileName: 'b.cpp',
                resolved: false,
            }),
            episode({
                errorEventId: 'r-b',
                fileUri: B_EXE_URI,
                fileName: 'b.exe',
                resolved: false,
            }),
        ]);
        assert.deepStrictEqual(collectFileOptions(view), [
            { value: B_EXE_URI, label: 'b.cpp' },
        ]);
    });
});

describe('时间线晚→早排序(2026-08-29 实测修复)', () => {
    // 多天真实事件流:3 天前仍未解决的编译错(置顶区)+ 昨天/今天各一至两张
    // 已解决编译卡。锁定三个层级的「自上而下从晚到早」:天组之间、卡之间、
    // 卡内条目(此前卡内是早→晚,与整页方向相反,学生实测观感为乱序)。
    const HOUR = 3_600_000;

    function compileErrorEvent2(
        id: string,
        timestamp: number,
        message: string,
        fileUri: string = 'file:///w/main.cpp'
    ): CompileErrorEvent {
        return {
            id,
            type: 'compile_error',
            timestamp,
            sessionId: 'session',
            workspaceId: 'ws',
            fileUri,
            stderr: `${fileUri}:12:5: error: ${message}`,
            parsedErrors: [
                {
                    raw: `error: ${message}`,
                    file: fileUri,
                    line: 12,
                    severity: 'error',
                    message,
                },
            ],
            exitCode: 1,
            durationMs: 800,
        };
    }

    function codeModifiedEvent(id: string, timestamp: number): CodeModifiedEvent {
        return {
            id,
            type: 'code_modified',
            timestamp,
            sessionId: 'session',
            workspaceId: 'ws',
            fileUri: 'file:///w/main.cpp',
            before: 'int main() {\n    x\n}',
            after: 'int main() {\n    int x;\n}',
            diff: '-    x\n+    int x;',
            trigger: 'post_compile_error',
        };
    }

    function compileSuccessEvent(id: string, timestamp: number): CompileSuccessEvent {
        return {
            id,
            type: 'compile_success',
            timestamp,
            sessionId: 'session',
            workspaceId: 'ws',
            fileUri: 'file:///w/main.cpp',
            exitCode: 0,
            durationMs: 700,
        };
    }

    /** 一个完整编译生命周期:失败(→可选编辑)→成功。 */
    function lifecycle(id: string, errorAt: number, message: string, withEdit: boolean): DebugEvent[] {
        const events: DebugEvent[] = [compileErrorEvent2(`${id}-err`, errorAt, message)];
        if (withEdit) {
            events.push(codeModifiedEvent(`${id}-edit`, errorAt + HOUR));
        }
        events.push(compileSuccessEvent(`${id}-ok`, errorAt + (withEdit ? 2 : 1) * HOUR));
        return events;
    }

    it('天组之间晚→早,组内卡之间晚→早,未解决置顶区在最前', () => {
        const view = buildJourneyViewModel([
            ...lifecycle('y', NOW - 26 * HOUR, 'yday error', false),
            ...lifecycle('t1', NOW - 3 * HOUR, 'today error one', true),
            ...lifecycle('t2', NOW - 30 * 60_000, 'today error two', false),
            // 置顶未解决卡用独立文件:同一文件的后续编译成功会把更早的失败
            // 收编为同生命周期「再次编译失败」(attemptsBeforeResolve 既有设计),
            // 不再是未解决卡。
            compileErrorEvent2(
                'old-un',
                NOW - 72 * HOUR,
                'old unresolved error',
                'file:///w/legacy.cpp'
            ),
        ]);
        const { unresolved, byDay } = buildTimelineSections(view, { ...EMPTY_FILTER }, NOW);

        // 天组之间:今天 → 昨天 → 更早,晚→早。
        assert.deepStrictEqual(byDay.map((g) => g.label), ['今天', '昨天']);
        // 卡之间:每个日组内按首次出现晚→早。
        assert.deepStrictEqual(
            byDay[0].episodes.map((e) => e.errorEventId),
            ['t2-err', 't1-err'],
            '今天组内晚→早'
        );
        assert.deepStrictEqual(byDay[1].episodes.map((e) => e.errorEventId), ['y-err']);
        // 未解决置顶区(设计:唯一的主动引导)自身也晚→早。
        assert.deepStrictEqual(unresolved.map((e) => e.errorEventId), ['old-un']);
    });

    it('卡内条目晚→早:最新的动态排在最上', () => {
        const view = buildJourneyViewModel(
            lifecycle('t1', NOW - 3 * HOUR, 'today error one', true)
        );
        const card = view.episodes.find((e) => e.errorEventId === 't1-err');
        assert.ok(card);
        assert.deepStrictEqual(
            card.entries.map((e) => e.kind),
            ['compile_success', 'code_modified', 'compile_error'],
            '卡内条目按时间降序(晚→早)'
        );
    });
});
