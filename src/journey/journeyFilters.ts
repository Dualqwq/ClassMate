import type { JourneyEntryVM, JourneyEpisodeVM, JourneyViewModel, MistakeCardVM } from './journeyViewModel';

/**
 * Journey 面板的过滤/分组纯函数(#12a)。
 * 设计文档 §4.2:过滤是纯前端状态——数据已在手(一次 journey:sync 推全量
 * 视图模型),变更过滤不回 extension 重取,也不持久化。
 * 放在 src/journey/(而非 webview/)以便 mocha 直接单测;webview 组件
 * 只做 import 与渲染。
 */

/** 条目类型多选用的人类可读档位(渲染层标签在此统一维护)。 */
export const ENTRY_TYPE_LABELS: Record<JourneyEntryVM['kind'], string> = {
    compile_error: '编译失败',
    compile_success: '编译成功',
    code_modified: '编辑',
    hint_requested: '求助',
    run_error: '运行',
};

export type JourneyEntryKind = keyof typeof ENTRY_TYPE_LABELS;

export interface JourneyFilterState {
    /** 选中的条目类型;全选 = 全部档位。 */
    types: JourneyEntryKind[];
    /** 'all' 或具体 fileUri。 */
    file: string;
    unresolvedOnly: boolean;
}

export const EMPTY_FILTER: JourneyFilterState = {
    types: Object.keys(ENTRY_TYPE_LABELS) as JourneyEntryKind[],
    file: 'all',
    unresolvedOnly: false,
};

export interface EpisodeDayGroup {
    /** 折叠组头文案:今天 / 昨天 / M月D日。 */
    label: string;
    episodes: JourneyEpisodeVM[];
}

/** episode 是否通过文件与未解决过滤(条目类型过滤只作用于条目列表)。 */
function episodeMatchesFilter(episode: JourneyEpisodeVM, filter: JourneyFilterState): boolean {
    if (filter.unresolvedOnly && episode.resolved) {
        return false;
    }
    if (filter.file !== 'all' && episode.fileUri !== filter.file) {
        return false;
    }
    return true;
}

/** 条目类型过滤:episode 内只显示选中类型的条目(卡头的起始错误不受影响)。 */
function filterEntries(
    episode: JourneyEpisodeVM,
    filter: JourneyFilterState
): JourneyEntryVM[] {
    return episode.entries.filter((entry) => filter.types.includes(entry.kind));
}

function dayLabel(timestamp: number, nowMs: number): string {
    const date = new Date(timestamp);
    const now = new Date(nowMs);
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (timestamp >= startOfToday) {
        return '今天';
    }
    if (timestamp >= startOfToday - 86_400_000) {
        return '昨天';
    }
    return `${date.getMonth() + 1}月${date.getDate()}日`;
}

/**
 * 时间线数据整理:未解决置顶区 + 已解决按日折叠(组内按首次出现倒序)。
 * 条目类型过滤后没有任何条目的 episode 不显示。
 * nowMs 由调用方注入(缺省取当前时间),保证分组结果可单测。
 */
export function buildTimelineSections(
    view: JourneyViewModel,
    filter: JourneyFilterState,
    nowMs: number = Date.now()
): { unresolved: JourneyEpisodeVM[]; byDay: EpisodeDayGroup[] } {
    const visible = view.episodes.filter((episode) => {
        if (!episodeMatchesFilter(episode, filter)) {
            return false;
        }
        return filterEntries(episode, filter).length > 0;
    });

    const unresolved = visible
        .filter((episode) => !episode.resolved)
        .sort((a, b) => b.firstSeenAt - a.firstSeenAt);

    const dayOrder: string[] = [];
    const byDayMap = new Map<string, JourneyEpisodeVM[]>();
    for (const episode of visible.filter((e) => e.resolved)) {
        const label = dayLabel(episode.firstSeenAt, nowMs);
        if (!byDayMap.has(label)) {
            byDayMap.set(label, []);
            dayOrder.push(label);
        }
        byDayMap.get(label)!.push(episode);
    }
    for (const list of byDayMap.values()) {
        list.sort((a, b) => b.firstSeenAt - a.firstSeenAt);
    }

    return { unresolved, byDay: dayOrder.map((label) => ({ label, episodes: byDayMap.get(label)! })) };
}

/** 文件下拉选项:全部 episode 出现过的文件(去重,按名称排)。 */
export function collectFileOptions(view: JourneyViewModel): Array<{ value: string; label: string }> {
    const files = new Map<string, string>();
    for (const episode of view.episodes) {
        if (episode.fileUri) {
            files.set(episode.fileUri, episode.fileName ?? episode.fileUri);
        }
    }
    return [...files.entries()]
        .map(([value, label]) => ({ value, label }))
        .sort((a, b) => a.label.localeCompare(b.label));
}

export type MistakeSortMode = 'recommended' | 'recent';

/**
 * 错题本排序:'recommended' = 视图模型既有顺序(sortKnowledgeCards:未解决 >
 * 频率 > 平均尝试 > 最近,未解决天然置顶);'recent' = 最近出现倒序。
 */
export function sortMistakeCards(
    cards: MistakeCardVM[],
    mode: MistakeSortMode
): MistakeCardVM[] {
    if (mode === 'recent') {
        return [...cards].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
    }
    return cards;
}
