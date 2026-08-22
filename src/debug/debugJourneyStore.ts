import * as vscode from 'vscode';
import { appendFile } from 'fs/promises';
import {
    getEventsFileUri,
    getIndexFileUri,
    getWorkspaceId,
    getWorkspaceStorageUri,
} from './storagePath';
import type { DebugEvent, DebugEventFilter } from './types';

const EVENTS_STORAGE_KEY = 'classmate.debugJourney.events.v1';
const INDEX_STORAGE_KEY = 'classmate.debugJourney.index.v1';
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
            events.push(JSON.parse(trimmed) as DebugEvent);
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

export class DebugJourneyStore {
    private readonly _context: vscode.ExtensionContext;
    private readonly _workspaceId: string;
    private readonly _workspaceStorage: vscode.Uri;
    private readonly _eventsUri: vscode.Uri;
    private readonly _indexUri: vscode.Uri;
    /**
     * 事件追加后的通知(#12a):Journey 面板据此做 500ms 合并窗口的节流重算。
     * 纯新增的订阅口,不改变 append 的既有语义与返回值。
     */
    private readonly _onDidAppend = new vscode.EventEmitter<DebugEvent[]>();
    public readonly onDidAppend = this._onDidAppend.event;

    constructor(context: vscode.ExtensionContext, workspaceId?: string) {
        this._context = context;
        this._workspaceId = workspaceId ?? getWorkspaceId();
        this._workspaceStorage = getWorkspaceStorageUri(
            context.globalStorageUri,
            this._workspaceId
        );
        this._eventsUri = getEventsFileUri(this._workspaceStorage);
        this._indexUri = getIndexFileUri(this._workspaceStorage);
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

        await ensureDirectory(this._workspaceStorage);

        const sanitized = events.map(sanitizeEvent);
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
        try {
            await vscode.workspace.fs.delete(this._eventsUri, { useTrash: false });
        } catch {
            // File may not exist.
        }
        await this._context.globalState.update(EVENTS_STORAGE_KEY, undefined);
        await this._context.globalState.update(INDEX_STORAGE_KEY, undefined);
        await this._writeIndex(createEmptyIndex());
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

    public dispose(): void {
        this._onDidAppend.dispose();
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
