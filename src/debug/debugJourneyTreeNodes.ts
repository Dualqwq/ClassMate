import * as vscode from 'vscode';
import type {
    CompileErrorEvent,
    CompileSuccessEvent,
    CodeModifiedEvent,
    DebugEvent,
    HintRequestedEvent,
    RunErrorEvent,
} from './types';
import {
    isCompileError,
    isCompileSuccess,
    isCodeModified,
    isHintRequested,
    isRunError,
} from './types';
import { formatFixAsDiff } from './formatDiff';

export type DebugJourneyNodeType =
    | 'fileNode'
    | 'sessionNode'
    | 'compileErrorNode'
    | 'compileSuccessNode'
    | 'codeModifiedNode'
    | 'hintRequestedNode'
    | 'runErrorNode';

export interface DebugJourneyNode {
    id: string;
    type: DebugJourneyNodeType;
    label: string;
    description?: string;
    tooltip?: vscode.MarkdownString | string;
    iconPath?: vscode.ThemeIcon;
    collapsibleState: vscode.TreeItemCollapsibleState;
    contextValue?: string;
    command?: vscode.Command;
    children: DebugJourneyNode[];

    /** Undo/revert metadata; preserved so future revert commands need no node-shape changes. */
    eventId?: string;
    fileUri?: string;
    event?: DebugEvent;
    snapshot?: { before: string; after: string };
}

const UNKNOWN_FILE_LABEL = 'Other files';
const UNKNOWN_FILE_KEY = '__unknown__';

function formatTimeDescription(timestamp: number): string {
    const date = new Date(timestamp);
    return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatDateBucket(timestamp: number): string {
    const date = new Date(timestamp);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function countChangedLines(before: string, after: string): number {
    const diffText = formatFixAsDiff(before, after);
    return diffText.split('\n').filter((line) => line.startsWith('- ') || line.startsWith('+ ')).length;
}

export function buildDiffTooltip(before: string, after: string): vscode.MarkdownString {
    const diffText = formatFixAsDiff(before, after);
    const md = new vscode.MarkdownString();
    md.appendCodeblock(diffText, 'diff');
    md.isTrusted = false;
    return md;
}

function buildCompileErrorNode(event: CompileErrorEvent): DebugJourneyNode {
    const errors = event.parsedErrors.filter((p) => p.severity === 'error' || p.severity === 'warning');
    const firstMessage = errors[0]?.message ?? 'Unknown compile error';
    const summaryLines: string[] = [];
    for (const p of errors.slice(0, 8)) {
        const location = `${p.file ?? '?'}:${p.line ?? '?'}:${p.column ?? '?'}`;
        summaryLines.push(`- **[${p.severity ?? 'error'}]** ${location}: ${p.message}`);
    }
    if (errors.length > 8) {
        summaryLines.push(`- ... and ${errors.length - 8} more diagnostic(s)`);
    }

    return {
        id: `debug-journey::${event.fileUri ?? UNKNOWN_FILE_KEY}::${formatDateBucket(event.timestamp)}::${event.id}`,
        type: 'compileErrorNode',
        label: firstMessage,
        description: formatTimeDescription(event.timestamp),
        tooltip: new vscode.MarkdownString(summaryLines.join('\n')),
        iconPath: new vscode.ThemeIcon('error'),
        collapsibleState: vscode.TreeItemCollapsibleState.None,
        // 树项行内「打开大屏」动作(view/item/context)以此 when 匹配。
        contextValue: 'compileErrorNode',
        eventId: event.id,
        fileUri: event.fileUri,
        event,
        children: [],
    };
}

function buildCompileSuccessNode(event: CompileSuccessEvent, fileUri?: string): DebugJourneyNode {
    return {
        id: `debug-journey::${fileUri ?? UNKNOWN_FILE_KEY}::${formatDateBucket(event.timestamp)}::${event.id}`,
        type: 'compileSuccessNode',
        label: 'Compiled successfully',
        description: formatTimeDescription(event.timestamp),
        iconPath: new vscode.ThemeIcon('check'),
        collapsibleState: vscode.TreeItemCollapsibleState.None,
        eventId: event.id,
        fileUri,
        event,
        children: [],
    };
}

function buildCodeModifiedNode(event: CodeModifiedEvent): DebugJourneyNode {
    const changedLineCount = countChangedLines(event.before, event.after);
    return {
        id: `debug-journey::${event.fileUri ?? UNKNOWN_FILE_KEY}::${formatDateBucket(event.timestamp)}::${event.id}`,
        type: 'codeModifiedNode',
        label: `Edit (${changedLineCount} changed line${changedLineCount === 1 ? '' : 's'})`,
        description: formatTimeDescription(event.timestamp),
        tooltip: buildDiffTooltip(event.before, event.after),
        iconPath: new vscode.ThemeIcon('diff'),
        collapsibleState: vscode.TreeItemCollapsibleState.None,
        contextValue: 'codeModifiedNode',
        command: {
            command: 'classmate.openDebugNodeDiff',
            title: 'Open Diff',
            arguments: [event.id, event.fileUri],
        },
        eventId: event.id,
        fileUri: event.fileUri,
        event,
        snapshot: { before: event.before, after: event.after },
        children: [],
    };
}

function buildHintRequestedNode(event: HintRequestedEvent): DebugJourneyNode {
    return {
        id: `debug-journey::${event.fileUri ?? UNKNOWN_FILE_KEY}::${formatDateBucket(event.timestamp)}::${event.id}`,
        type: 'hintRequestedNode',
        label: `Hint: ${event.intent}`,
        description: formatTimeDescription(event.timestamp),
        tooltip: event.userPrompt,
        iconPath: new vscode.ThemeIcon('lightbulb'),
        collapsibleState: vscode.TreeItemCollapsibleState.None,
        eventId: event.id,
        fileUri: event.fileUri,
        event,
        children: [],
    };
}

function buildRunErrorNode(event: RunErrorEvent, fileUri?: string): DebugJourneyNode {
    const executable = event.executablePath.split(/[\\/]/).pop() ?? event.executablePath;
    return {
        id: `debug-journey::${fileUri ?? UNKNOWN_FILE_KEY}::${formatDateBucket(event.timestamp)}::${event.id}`,
        type: 'runErrorNode',
        label: `Runtime error: ${executable}`,
        description: formatTimeDescription(event.timestamp),
        tooltip: event.stderr ?? event.stdout ?? 'Runtime error',
        iconPath: new vscode.ThemeIcon('debug-disconnect'),
        collapsibleState: vscode.TreeItemCollapsibleState.None,
        eventId: event.id,
        fileUri,
        event,
        children: [],
    };
}

function buildEventNode(event: DebugEvent): DebugJourneyNode | undefined {
    if (isCompileError(event)) {
        return buildCompileErrorNode(event);
    }
    if (isCompileSuccess(event)) {
        return buildCompileSuccessNode(event, event.fileUri);
    }
    if (isCodeModified(event)) {
        return buildCodeModifiedNode(event);
    }
    if (isHintRequested(event)) {
        return buildHintRequestedNode(event);
    }
    if (isRunError(event)) {
        return buildRunErrorNode(event, event.fileUri);
    }
    return undefined;
}

function getFileKey(event: DebugEvent): string {
    return event.fileUri ?? UNKNOWN_FILE_KEY;
}

function getFileLabel(fileUri: string): string {
    if (fileUri === UNKNOWN_FILE_KEY) {
        return UNKNOWN_FILE_LABEL;
    }
    try {
        const uri = vscode.Uri.parse(fileUri);
        return uri.path.split(/[\\/]/).pop() ?? fileUri;
    } catch {
        return fileUri;
    }
}

/**
 * Group debug events into a file → date → event tree.
 *
 * Ordering:
 * - Files are sorted alphabetically by label.
 * - Date buckets within a file are sorted newest first.
 * - Events within a date bucket are sorted oldest first (chronological narrative).
 */
export function buildDebugJourneyNodes(events: DebugEvent[]): DebugJourneyNode[] {
    const byFile = new Map<string, DebugEvent[]>();
    for (const event of events) {
        const key = getFileKey(event);
        const group = byFile.get(key);
        if (group) {
            group.push(event);
        } else {
            byFile.set(key, [event]);
        }
    }

    const fileKeys = [...byFile.keys()].sort((a, b) => {
        // Keep unknown group at the bottom.
        if (a === UNKNOWN_FILE_KEY) {
            return 1;
        }
        if (b === UNKNOWN_FILE_KEY) {
            return -1;
        }
        return getFileLabel(a).localeCompare(getFileLabel(b));
    });

    const roots: DebugJourneyNode[] = [];

    for (const fileKey of fileKeys) {
        const fileEvents = byFile.get(fileKey) ?? [];
        const byDate = new Map<string, DebugEvent[]>();
        for (const event of fileEvents) {
            const date = formatDateBucket(event.timestamp);
            const group = byDate.get(date);
            if (group) {
                group.push(event);
            } else {
                byDate.set(date, [event]);
            }
        }

        const dates = [...byDate.keys()].sort().reverse();
        const sessionChildren: DebugJourneyNode[] = [];

        for (const date of dates) {
            const dayEvents = (byDate.get(date) ?? []).slice().sort((a, b) => a.timestamp - b.timestamp);
            const eventChildren: DebugJourneyNode[] = [];
            for (const event of dayEvents) {
                const node = buildEventNode(event);
                if (node) {
                    eventChildren.push(node);
                }
            }
            if (eventChildren.length === 0) {
                continue;
            }
            sessionChildren.push({
                id: `debug-journey::${fileKey}::${date}`,
                type: 'sessionNode',
                label: date,
                collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
                children: eventChildren,
            });
        }

        if (sessionChildren.length === 0) {
            continue;
        }

        roots.push({
            id: `debug-journey::${fileKey}`,
            type: 'fileNode',
            label: getFileLabel(fileKey),
            collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
            children: sessionChildren,
        });
    }

    return roots;
}
