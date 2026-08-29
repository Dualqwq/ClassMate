import type { JourneyEntryVM, JourneyEpisodeVM, JourneyViewModel, MistakeCardVM } from './journeyViewModel';
import { RUN_ERROR_KINDS, RUN_ERROR_KIND_LABELS, type RunErrorKind } from '../run/runErrorKind';
import { formatFileDisplayPath, sameProgramFile } from '../debug/fileIdentity';

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
    run_error: '运行出错',
    run_success: '运行成功',
};

/** 级别多选档位(错误/警告/信息),与类型/文件/未解决过滤器正交。 */
export const SEVERITY_LEVEL_LABELS = {
    error: '错误',
    warning: '警告',
    info: '信息',
} as const;

export type SeverityLevel = keyof typeof SEVERITY_LEVEL_LABELS;

export type JourneyEntryKind = keyof typeof ENTRY_TYPE_LABELS;

export { RUN_ERROR_KINDS, RUN_ERROR_KIND_LABELS };
export type RunErrorKindFilter = RunErrorKind;

export interface JourneyFilterState {
    /** 选中的条目类型;全选 = 全部档位。 */
    types: JourneyEntryKind[];
    /** 选中的诊断级别;全选 = 错误与警告都显示。 */
    levels: SeverityLevel[];
    /**
     * 选中的 run 错误分类(仅作用于 run_error 条目与独立 run_error 卡);
     * 全选 = 全部分类都显示。
     */
    runErrorKinds: RunErrorKind[];
    /** 'all' 或具体 fileUri。 */
    file: string;
    unresolvedOnly: boolean;
}

export const EMPTY_FILTER: JourneyFilterState = {
    types: Object.keys(ENTRY_TYPE_LABELS) as JourneyEntryKind[],
    levels: Object.keys(SEVERITY_LEVEL_LABELS) as SeverityLevel[],
    runErrorKinds: [...RUN_ERROR_KINDS],
    file: 'all',
    unresolvedOnly: false,
};

export interface EpisodeDayGroup {
    /** 折叠组头文案:今天 / 昨天 / M月D日。 */
    label: string;
    episodes: JourneyEpisodeVM[];
}

/**
 * 文件档匹配:精确 URI 相等,或同一程序——**同目录且同文件名 stem**
 * (如 a.cpp ↔ a.exe)视为同一文件档。学生在文件下拉选 a.exe 时理应看到
 * a.cpp 的编译错误:同一程序的编译+运行是一条时间线,而旧事件(run 只有
 * exe fileUri、无 sourceFileUri)的选项值只有 exe URI,纯精确匹配会让
 * a.cpp 编译卡在筛 a.exe 时消失。
 *
 * 2026-08-29 跨目录撞名修复:旧实现只比裸 stem(problem1/a.cpp 与
 * problem2/a.cpp 同 stem 'a'),按任一 a.cpp 筛选会把另一个目录的同名
 * 文件条目也带出来。现改为带目录限定的 stem 等值(sameProgramFile):
 * 两侧都是绝对目录时必须同目录;任一侧无目录证据(旧事件相对路径/裸名)
 * 退回 stem 兜底,升级窗口行为与旧版一致。
 */
function fileMatchesEpisode(episodeFileUri: string | undefined, filterFile: string): boolean {
    if (episodeFileUri === filterFile) {
        return true;
    }
    return sameProgramFile(filterFile, episodeFileUri);
}

/** episode 是否通过级别/文件/未解决过滤(条目类型过滤只作用于条目列表)。 */
function episodeMatchesFilter(episode: JourneyEpisodeVM, filter: JourneyFilterState): boolean {
    // 级别:VM 未带 severity 的旧数据按 error 兜底。
    const level = episode.severity ?? 'error';
    if (!filter.levels.includes(level)) {
        return false;
    }
    // run 错误分类:独立 run_error 卡按 kind 过滤;其余卡不受影响。
    if (episode.runErrorKind && !filter.runErrorKinds.includes(episode.runErrorKind)) {
        return false;
    }
    if (filter.unresolvedOnly && episode.resolved) {
        return false;
    }
    if (filter.file !== 'all' && !fileMatchesEpisode(episode.fileUri, filter.file)) {
        return false;
    }
    return true;
}

/** 条目类型过滤:episode 内只显示选中类型的条目(卡头的起始错误不受影响)。 */
function filterEntries(
    episode: JourneyEpisodeVM,
    filter: JourneyFilterState
): JourneyEntryVM[] {
    return episode.entries.filter((entry) => {
        if (!filter.types.includes(entry.kind)) {
            return false;
        }
        // run_error 条目再过一层分类过滤。
        if (
            entry.kind === 'run_error' &&
            entry.runErrorKind &&
            !filter.runErrorKinds.includes(entry.runErrorKind)
        ) {
            return false;
        }
        return true;
    });
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
    // 过滤后的条目随卡输出(浅拷贝):渲染层只画选中类型的条目,
    // 与「episode 内只显示选中类型的条目」的注释意图一致。
    const visible = view.episodes
        .filter((episode) => {
            if (!episodeMatchesFilter(episode, filter)) {
                return false;
            }
            return filterEntries(episode, filter).length > 0;
        })
        .map((episode) => ({ ...episode, entries: filterEntries(episode, filter) }));

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

/**
 * 文件下拉选项:全部 episode 出现过的文件,按「同一程序」收敛去重,按名称排。
 *
 * 2026-08-29 实测修复:编译卡与运行卡对同一个文件携带两种形态的 fileUri——
 * 编译卡取解析诊断行里的报错文件(journeyViewModel 的 parsed.file,纯
 * Windows 路径如 c:\ws\b.cpp,含头文件错误场景须指向真实报错文件的既有
 * 设计),运行卡取事件自带的 sourceFileUri/fileUri(percent 编码 file://
 * URI)。旧实现按 fileUri 精确字符串去重,同一文件出两个选项、label 渲染
 * 同名(用户实测「文件下拉出现两个 b.cpp」)。
 *
 * 2026-08-29 跨目录撞名修复(用户实测「problem1/a.cpp 与 problem2/a.cpp
 * 分不开」):中间版的 stem 收敛键(problemKey 只取 basename)会把不同目录
 * 的同名文件并成一个选项。现按「同一程序」成对判定(sameProgramFile,与
 * fileMatchesEpisode 完全同口径)分桶:同一文件的双 URI 形态(纯路径 vs
 * file://、分隔符/盘符大小写差异)与同目录 a.cpp↔a.exe 收敛为一个选项,
 * 异目录同 stem 文件分开为各自选项。
 * 取值优先 file:// URI 形态(事件自带规范形态,纯路径是解析器从 stderr
 * 剥出的);label 用工作区相对路径(view.workspaceRoot 由 JourneyService
 * 随视图模型下发),桶内优先取源文件扩展名(.cpp/.cc/.cxx/.c)episode 的
 * label——a.cpp↔a.exe 桶对学生应叫 a.cpp 而不是 a.exe。
 */
const SOURCE_FILE_EXT = /\.(cpp|cc|cxx|c)$/i;

export function collectFileOptions(view: JourneyViewModel): Array<{ value: string; label: string }> {
    const buckets: Array<{ value: string; label: string; labelIsSource: boolean }> = [];
    for (const episode of view.episodes) {
        if (!episode.fileUri) {
            continue;
        }
        const label = formatFileDisplayPath(episode.fileUri, view.workspaceRoot);
        if (label === undefined) {
            continue;
        }
        const labelIsSource = SOURCE_FILE_EXT.test(episode.fileUri);
        const existing = buckets.find((bucket) => sameProgramFile(bucket.value, episode.fileUri));
        if (!existing) {
            buckets.push({ value: episode.fileUri, label, labelIsSource });
            continue;
        }
        if (!existing.value.startsWith('file://') && episode.fileUri.startsWith('file://')) {
            existing.value = episode.fileUri;
        }
        if (!existing.labelIsSource && labelIsSource) {
            existing.label = label;
            existing.labelIsSource = true;
        }
    }
    return buckets
        .map(({ value, label }) => ({ value, label }))
        .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * 指标条分级汇总(跟随当前筛选):对「当前可见」的 episode 按级别拆
 * 已解决/未解决计数。调用方传入 buildTimelineSections 输出里的全部可见卡
 * (未解决置顶 + 已按日折叠),保证指标条数字与列表所见一致。
 */
export function summarizeEpisodesBySeverity(episodes: JourneyEpisodeVM[]): {
    resolved: number;
    unresolved: number;
    unresolvedErrors: number;
    unresolvedWarnings: number;
} {
    const resolved = episodes.filter((e) => e.resolved).length;
    const unresolvedList = episodes.filter((e) => !e.resolved);
    return {
        resolved,
        unresolved: unresolvedList.length,
        unresolvedErrors: unresolvedList.filter((e) => (e.severity ?? 'error') === 'error').length,
        unresolvedWarnings: unresolvedList.filter((e) => e.severity === 'warning').length,
    };
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

export type MistakeGroupMode = 'tag' | 'problemKey';

/** 错题本一个分组:组头键 + 展示文案 + 组内卡片(保持视图模型既有顺序)。 */
export interface MistakeCardGroup {
    key: string;
    label: string;
    cards: MistakeCardVM[];
}

const UNGROUPED_PROBLEM_LABEL = '未关联题目';

/**
 * 错题本分组(#14b):
 * - 'tag'(现状):每张卡本身就是一次标签聚合,一卡一组,渲染与旧版一致;
 * - 'problemKey':按题目分组(deriveProblemKey 派生),无 problemKey 的卡
 *   归入「未关联题目」并置底。
 */
export function groupMistakeCards(
    cards: MistakeCardVM[],
    mode: MistakeGroupMode
): MistakeCardGroup[] {
    if (mode === 'tag') {
        return cards.map((card) => ({
            key: card.tag,
            label: card.title || card.tag,
            cards: [card],
        }));
    }

    const groups = new Map<string, MistakeCardVM[]>();
    for (const card of cards) {
        const key = card.problemKey ?? '';
        const group = groups.get(key);
        if (group) {
            group.push(card);
        } else {
            groups.set(key, [card]);
        }
    }
    const labeled = [...groups.entries()]
        .filter(([key]) => key !== '')
        .map(([key, groupCards]) => ({ key, label: key, cards: groupCards }));
    const ungrouped = groups.get('');
    if (ungrouped) {
        labeled.push({ key: '', label: UNGROUPED_PROBLEM_LABEL, cards: ungrouped });
    }
    return labeled;
}
