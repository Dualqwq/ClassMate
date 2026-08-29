import * as vscode from 'vscode';
import { appendFile } from 'fs/promises';
import {
    getEventsFileUri,
    getIndexFileUri,
    getResolvedFileUri,
    getWorkspaceId,
    getWorkspaceStorageUri,
} from './storagePath';
import {
    computeEventFingerprint,
    EVENT_SCHEMA_VERSION,
    SEMANTIC_DEDUPE_WINDOW_MS,
} from './eventEnvelope';
import type { DebugEvent, DebugEventFilter } from './types';

const EVENTS_STORAGE_KEY = 'classmate.debugJourney.events.v1';
const INDEX_STORAGE_KEY = 'classmate.debugJourney.index.v1';
/** 学生手动「已解决」标记的持久化文件(resolved.json,按 problemKey 粒度)。 */
const RESOLVED_STORAGE_KEY = 'classmate.debugJourney.resolved.v1';
const MAX_EVENTS_PER_WORKSPACE = 2000;
const ROTATION_BATCH = Math.floor(MAX_EVENTS_PER_WORKSPACE * 0.1);
const MAX_FIELD_LENGTH = 16 * 1024;
const HOT_CACHE_SIZE = 50;

export interface DebugEventIndex {
    total: number;
    lastEventId?: string;
    lastTimestamp?: number;
    counts: Record<DebugEvent['type'], number>;
}

function createEmptyIndex(): DebugEventIndex {
    return {
        total: 0,
        counts: {
            compile_error: 0,
            compile_success: 0,
            run_success: 0,
            run_error: 0,
            hint_requested: 0,
            code_modified: 0,
        },
    };
}

function truncateField(value: string): string {
    if (value.length <= MAX_FIELD_LENGTH) {
        return value;
    }
    return value.slice(0, MAX_FIELD_LENGTH) + '\n<truncated>';
}

function sanitizeEvent(event: DebugEvent): DebugEvent {
    switch (event.type) {
        case 'compile_error':
            return {
                ...event,
                stderr: truncateField(event.stderr),
            };
        case 'run_error':
            return {
                ...event,
                stdout: event.stdout === undefined ? undefined : truncateField(event.stdout),
                stderr: event.stderr === undefined ? undefined : truncateField(event.stderr),
            };
        case 'code_modified':
            return {
                ...event,
                before: truncateField(event.before),
                after: truncateField(event.after),
                diff: truncateField(event.diff),
            };
        default:
            return event;
    }
}

async function ensureDirectory(uri: vscode.Uri): Promise<void> {
    try {
        await vscode.workspace.fs.createDirectory(uri);
    } catch {
        // Directory may already exist.
    }
}

async function readTextFile(uri: vscode.Uri): Promise<string | undefined> {
    try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        return Buffer.from(bytes).toString('utf-8');
    } catch {
        return undefined;
    }
}

async function writeTextFile(uri: vscode.Uri, content: string): Promise<void> {
    const bytes = Buffer.from(content, 'utf-8');
    await vscode.workspace.fs.writeFile(uri, bytes);
}

function parseEvents(text: string): DebugEvent[] {
    const events: DebugEvent[] = [];
    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) {
            continue;
        }
        try {
            const raw = JSON.parse(trimmed) as DebugEvent;
            // 版本迁移(读视图):v1 旧格式无信封字段,补 schemaVersion=1 后
            // 照常返回,不重写文件、不炸消费端。
            events.push(raw.schemaVersion === undefined ? { ...raw, schemaVersion: 1 } : raw);
        } catch {
            // Ignore malformed lines.
        }
    }
    return events;
}

function eventMatchesFilter(event: DebugEvent, filter: DebugEventFilter): boolean {
    if (filter.workspaceId && event.workspaceId !== filter.workspaceId) {
        return false;
    }
    if (filter.fileUri && event.fileUri !== filter.fileUri) {
        return false;
    }
    if (filter.since && event.timestamp < filter.since) {
        return false;
    }
    if (filter.types && !filter.types.includes(event.type)) {
        return false;
    }
    return true;
}

/**
 * 幂等清除只容忍「文件不存在」:workspace.fs 对缺失文件抛的是
 * FileSystemError 且 code='FileNotFound'(extension host 会把底层
 * EntryNotFound 复原成该实例,code 取工厂方法名)。
 * 注:本 API 面(@types/vscode 1.125 / VS Code 1.128)没有
 * `FileSystemError.isFileNotFoundError` 静态判定,按 code 判断是同语义的稳定口径。
 */
function isFileNotFoundError(err: unknown): boolean {
    return err instanceof vscode.FileSystemError && err.code === 'FileNotFound';
}

/**
 * 幂等跳过的适用类型:错误类事件(compile_error/run_error)。它们是唯一
 * 存在「同一结果被多个触发源各写一次」结构性风险的类型;其余类型要么天然
 * 一次性(求助),要么有内容变化守卫(编辑),快速重复是学生真实动作。
 */
const IDEMPOTENT_SKIP_TYPES: ReadonlySet<DebugEvent['type']> = new Set([
    'compile_error',
    'run_error',
]);

export class DebugJourneyStore {
    private readonly _context: vscode.ExtensionContext;
    private readonly _workspaceId: string;
    private readonly _workspaceStorage: vscode.Uri;
    private readonly _eventsUri: vscode.Uri;
    private readonly _indexUri: vscode.Uri;
    private readonly _resolvedUri: vscode.Uri;
    /** 可注入时钟(单测控制幂等窗口)。 */
    private readonly _now: () => number;
    /** 最近写入的语义指纹 → 写入时刻;窗口内同指纹重复 append 直接跳过。 */
    private readonly _recentFingerprints = new Map<string, number>();
    /**
     * 事件追加后的通知(#12a):Journey 面板据此做 500ms 合并窗口的节流重算。
     * 纯新增的订阅口,不改变 append 的既有语义与返回值。
     */
    private readonly _onDidAppend = new vscode.EventEmitter<DebugEvent[]>();
    public readonly onDidAppend = this._onDidAppend.event;

    constructor(context: vscode.ExtensionContext, workspaceId?: string, options?: { now?: () => number }) {
        this._context = context;
        this._now = options?.now ?? (() => Date.now());
        this._workspaceId = workspaceId ?? getWorkspaceId();
        this._workspaceStorage = getWorkspaceStorageUri(
            context.globalStorageUri,
            this._workspaceId
        );
        this._eventsUri = getEventsFileUri(this._workspaceStorage);
        this._indexUri = getIndexFileUri(this._workspaceStorage);
        this._resolvedUri = getResolvedFileUri(this._workspaceStorage);
    }

    public get workspaceId(): string {
        return this._workspaceId;
    }

    public async append(event: DebugEvent): Promise<void> {
        await this.appendMany([event]);
    }

    public async appendMany(events: DebugEvent[]): Promise<void> {
        if (events.length === 0) {
            return;
        }

        // v2 信封 + 幂等窗口(复测问题 2):每条事件固化 schemaVersion 与语义
        // 指纹;错误类事件(compile_error/run_error)在短窗口内同指纹重复到达
        // (同一编译结果的多触发源重放)直接跳过,不落盘、不触发 onDidAppend。
        // 幂等跳过只收窄在错误类:成功/编辑/求助类各有天然一次性或内容守卫,
        // 且学生短时间内的真实重试不该在写入边界被吞掉——消费侧还有按指纹的
        // 折叠兜底(journeyViewModel.foldByFingerprint)。
        const now = this._now();
        for (const [fingerprint, seenAt] of this._recentFingerprints) {
            if (now - seenAt > SEMANTIC_DEDUPE_WINDOW_MS) {
                this._recentFingerprints.delete(fingerprint);
            }
        }
        const sanitized: DebugEvent[] = [];
        for (const event of events) {
            const fingerprint = event.fingerprint ?? computeEventFingerprint(event);
            const idempotentEligible = IDEMPOTENT_SKIP_TYPES.has(event.type);
            if (idempotentEligible) {
                const seenAt = this._recentFingerprints.get(fingerprint);
                if (seenAt !== undefined && now - seenAt <= SEMANTIC_DEDUPE_WINDOW_MS) {
                    continue;
                }
                this._recentFingerprints.set(fingerprint, now);
            }
            sanitized.push({ ...sanitizeEvent(event), schemaVersion: EVENT_SCHEMA_VERSION, fingerprint });
        }
        if (sanitized.length === 0) {
            return;
        }

        await ensureDirectory(this._workspaceStorage);

        // O(1) 追加(schema §2 缺口 7):events.jsonl 在 globalStorage 下是真实
        // 文件,直接 Node appendFile 只写新增行,不再读全量拼接重写——
        // 编译/运行是高频写入,原「读全文 + 写全文」会随文件增长线性变慢。
        const lines = sanitized.map((e) => JSON.stringify(e)).join('\n') + '\n';
        await appendFile(this._eventsUri.fsPath, lines, 'utf-8');

        await this._updateIndex(sanitized);
        await this._updateHotCache(sanitized);
        await this._rotateIfNeeded();
        this._onDidAppend.fire(sanitized);
    }

    public async getEvents(filter: DebugEventFilter = {}): Promise<DebugEvent[]> {
        const text = await readTextFile(this._eventsUri);
        if (!text) {
            return [];
        }

        const events = parseEvents(text);
        if (Object.keys(filter).length === 0) {
            return events;
        }

        return events.filter((event) => eventMatchesFilter(event, filter));
    }

    public async getLastEvent(filter: DebugEventFilter = {}): Promise<DebugEvent | undefined> {
        const events = await this.getEvents(filter);
        return events.length > 0 ? events[events.length - 1] : undefined;
    }

    public async clear(): Promise<void> {
        // 语义指纹幂等窗口同步作废:窗口描述「本实例最近落过盘什么」,clear 一旦
        // 被调用,它与磁盘的对应关系即不再可信——不重置的话,清除之后窗口内
        // 重编同一错误会被当重复吞掉,清除后的第一条新错误丢失。选择在入口
        // 无条件重置(而非「全部删除成功后才重置」):clear 中途抛错(如 events
        // 已删、resolved 失败的部分清除态)后磁盘真相已变,保留旧指纹反而会
        // 继续吞事件;无条件重置的最坏后果只是窗口内多写一条同指纹重复,
        // 消费侧 foldByFingerprint 本就按指纹折叠兜底,无正确性风险。
        this._recentFingerprints.clear();
        // 文件删除失败不许静默:杀软/索引器锁文件(EBUSY、Permission denied)
        // 时若吞掉错误,「清除」会假成功——旧事件仍在磁盘上,digest 照样注入。
        // 只有 FileNotFound(本就不存在,幂等清除的正常形态)才容忍。
        for (const uri of [this._eventsUri, this._resolvedUri]) {
            try {
                await vscode.workspace.fs.delete(uri, { useTrash: false });
            } catch (err) {
                if (!isFileNotFoundError(err)) {
                    throw err;
                }
                // File may not exist.
            }
        }
        await this._writeIndex(createEmptyIndex());
        // globalState 副本清理必须删「带 workspace 后缀」的键:三个写入端
        // (_updateHotCache 的热缓存≤50 条、_writeIndex 的 index 轻量副本、
        // _writeResolvedMarks 的 resolved 副本)写的全是 `${KEY}.${workspaceId}`,
        // 此前误删无后缀键,导致清除后热缓存与 resolved 副本残留——清除后的
        // 第一个新 append 会把最多 50 条旧事件重新并进热缓存。
        // 无后缀键是历史遗留形态(旧版本写入/清理用的键),一并删除做升级清理。
        const suffix = `.${this._workspaceId}`;
        await this._context.globalState.update(`${EVENTS_STORAGE_KEY}${suffix}`, undefined);
        await this._context.globalState.update(`${INDEX_STORAGE_KEY}${suffix}`, undefined);
        await this._context.globalState.update(`${RESOLVED_STORAGE_KEY}${suffix}`, undefined);
        await this._context.globalState.update(EVENTS_STORAGE_KEY, undefined);
        await this._context.globalState.update(INDEX_STORAGE_KEY, undefined);
        await this._context.globalState.update(RESOLVED_STORAGE_KEY, undefined);
    }

    public async getIndex(): Promise<DebugEventIndex> {
        const text = await readTextFile(this._indexUri);
        if (!text) {
            return createEmptyIndex();
        }
        try {
            return JSON.parse(text) as DebugEventIndex;
        } catch {
            return createEmptyIndex();
        }
    }

    /**
     * 学生手动「已解决」标记(按 problemKey 粒度):值是标记时刻的时间戳。
     * 只记录学生显式点击,绝不自动写入/翻转;「同题新 run_error 覆盖旧标记」
     * 的重置语义由消费侧(journeyViewModel)按时间戳派生,不在写入路径耦合。
     */
    public async getResolvedMarks(): Promise<Record<string, number>> {
        const text = await readTextFile(this._resolvedUri);
        if (!text) {
            return {};
        }
        try {
            const parsed = JSON.parse(text) as Record<string, unknown>;
            // 容错:只收合法的非负数值,坏行按不存在处理。
            const marks: Record<string, number> = {};
            for (const [key, value] of Object.entries(parsed)) {
                if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
                    marks[key] = value;
                }
            }
            return marks;
        } catch {
            return {};
        }
    }

    public async markProblemResolved(problemKey: string): Promise<void> {
        if (!problemKey) {
            return;
        }
        const marks = await this.getResolvedMarks();
        marks[problemKey] = this._now();
        await this._writeResolvedMarks(marks);
    }

    public async markProblemUnresolved(problemKey: string): Promise<void> {
        if (!problemKey) {
            return;
        }
        const marks = await this.getResolvedMarks();
        if (!(problemKey in marks)) {
            return;
        }
        delete marks[problemKey];
        await this._writeResolvedMarks(marks);
    }

    private async _writeResolvedMarks(marks: Record<string, number>): Promise<void> {
        await ensureDirectory(this._workspaceStorage);
        await writeTextFile(this._resolvedUri, JSON.stringify(marks));
        // 与 index 同款 globalState 轻量副本,激活期快速读取。
        await this._context.globalState.update(
            `${RESOLVED_STORAGE_KEY}.${this._workspaceId}`,
            marks
        );
    }

    public dispose(): void {
        this._onDidAppend.dispose();
        this._recentFingerprints.clear();
    }

    private async _updateIndex(events: DebugEvent[]): Promise<void> {
        const index = await this.getIndex();
        for (const event of events) {
            index.total += 1;
            index.counts[event.type] = (index.counts[event.type] ?? 0) + 1;
            index.lastEventId = event.id;
            index.lastTimestamp = event.timestamp;
        }
        await this._writeIndex(index);
    }

    private async _writeIndex(index: DebugEventIndex): Promise<void> {
        await ensureDirectory(this._workspaceStorage);
        await writeTextFile(this._indexUri, JSON.stringify(index));

        // Keep a lightweight copy in globalState for fast access on activation.
        const globalKey = `${INDEX_STORAGE_KEY}.${this._workspaceId}`;
        await this._context.globalState.update(globalKey, index);
    }

    private async _updateHotCache(events: DebugEvent[]): Promise<void> {
        const globalKey = `${EVENTS_STORAGE_KEY}.${this._workspaceId}`;
        const cached = this._context.globalState.get<DebugEvent[]>(globalKey, []);
        const updated = [...cached, ...events];
        if (updated.length > HOT_CACHE_SIZE) {
            updated.splice(0, updated.length - HOT_CACHE_SIZE);
        }
        await this._context.globalState.update(globalKey, updated);
    }

    private async _rotateIfNeeded(): Promise<void> {
        const index = await this.getIndex();
        if (index.total <= MAX_EVENTS_PER_WORKSPACE) {
            return;
        }

        const text = await readTextFile(this._eventsUri);
        if (!text) {
            return;
        }

        const lines = text.split('\n').filter((line) => line.trim().length > 0);
        const target = MAX_EVENTS_PER_WORKSPACE - ROTATION_BATCH;
        if (lines.length <= target) {
            return;
        }

        const kept = lines.slice(lines.length - target);
        await writeTextFile(this._eventsUri, kept.join('\n') + '\n');

        // Rebuild index from kept events.
        const keptEvents = kept
            .map((line) => {
                try {
                    return JSON.parse(line) as DebugEvent;
                } catch {
                    return undefined;
                }
            })
            .filter((e): e is DebugEvent => e !== undefined);

        const freshIndex = createEmptyIndex();
        freshIndex.total = keptEvents.length;
        for (const event of keptEvents) {
            freshIndex.counts[event.type] = (freshIndex.counts[event.type] ?? 0) + 1;
            freshIndex.lastEventId = event.id;
            freshIndex.lastTimestamp = event.timestamp;
        }
        await this._writeIndex(freshIndex);
    }
}
