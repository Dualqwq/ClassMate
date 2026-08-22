import * as assert from 'assert';
import { describe, it } from 'mocha';
import {
    buildTimelineSections,
    collectFileOptions,
    sortMistakeCards,
    EMPTY_FILTER,
    type JourneyFilterState,
} from '../journey/journeyFilters';
import type { JourneyEpisodeVM, JourneyViewModel, MistakeCardVM } from '../journey/journeyViewModel';

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
