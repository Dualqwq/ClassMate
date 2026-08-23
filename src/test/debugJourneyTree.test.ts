import * as assert from 'assert';
import { describe, it } from 'mocha';
import * as vscode from 'vscode';
import { buildDebugJourneyNodes, buildDiffTooltip } from '../debug/debugJourneyTreeNodes';
import type { DebugEvent } from '../debug/types';

function makeCompileError(
    id: string,
    fileUri: string | undefined,
    timestamp: number,
    message: string
): DebugEvent {
    return {
        id,
        type: 'compile_error',
        timestamp,
        sessionId: 's1',
        workspaceId: 'ws',
        fileUri,
        stderr: `main.cpp:1:1: error: ${message}`,
        parsedErrors: [
            {
                raw: `main.cpp:1:1: error: ${message}`,
                file: 'main.cpp',
                line: 1,
                column: 1,
                severity: 'error',
                message,
            },
        ],
        exitCode: 1,
        durationMs: 100,
    };
}

function makeCodeModified(
    id: string,
    fileUri: string,
    timestamp: number,
    before: string,
    after: string
): DebugEvent {
    return {
        id,
        type: 'code_modified',
        timestamp,
        sessionId: 's1',
        workspaceId: 'ws',
        fileUri,
        before,
        after,
        diff: '',
        trigger: 'manual',
    };
}

function makeCompileSuccess(id: string, fileUri: string, timestamp: number): DebugEvent {
    return {
        id,
        type: 'compile_success',
        timestamp,
        sessionId: 's1',
        workspaceId: 'ws',
        fileUri,
        exitCode: 0,
        durationMs: 100,
    };
}

function collectIds(node: ReturnType<typeof buildDebugJourneyNodes>[number]): string[] {
    const result: string[] = [node.id];
    for (const child of node.children) {
        result.push(...collectIds(child as ReturnType<typeof buildDebugJourneyNodes>[number]));
    }
    return result;
}

describe('Debug Journey tree nodes', () => {
    it('returns an empty tree for empty events', () => {
        const nodes = buildDebugJourneyNodes([]);
        assert.strictEqual(nodes.length, 0);
    });

    it('groups events by file and date', () => {
        const ts = new Date('2026-07-13T10:00:00Z').getTime();
        const events: DebugEvent[] = [
            makeCompileError('e1', 'file:///main.cpp', ts, "expected ';'"),
            makeCompileSuccess('s1', 'file:///main.cpp', ts + 1000),
        ];
        const nodes = buildDebugJourneyNodes(events);

        assert.strictEqual(nodes.length, 1);
        assert.strictEqual(nodes[0].type, 'fileNode');
        assert.strictEqual(nodes[0].label, 'main.cpp');
        assert.strictEqual(nodes[0].children.length, 1);

        const session = nodes[0].children[0];
        assert.strictEqual(session.type, 'sessionNode');
        assert.strictEqual(session.label, '2026-07-13');
        assert.strictEqual(session.children.length, 2);

        assert.strictEqual(session.children[0].type, 'compileErrorNode');
        assert.strictEqual(session.children[1].type, 'compileSuccessNode');
    });

    it('sorts multiple files alphabetically and keeps unknown at the bottom', () => {
        const ts = new Date('2026-07-13T10:00:00Z').getTime();
        const events: DebugEvent[] = [
            makeCompileError('e1', 'file:///beta.cpp', ts, 'error'),
            makeCompileError('e2', undefined, ts, 'error'),
            makeCompileError('e3', 'file:///alpha.cpp', ts, 'error'),
        ];
        const nodes = buildDebugJourneyNodes(events);

        assert.strictEqual(nodes.length, 3);
        assert.strictEqual(nodes[0].label, 'alpha.cpp');
        assert.strictEqual(nodes[1].label, 'beta.cpp');
        assert.strictEqual(nodes[2].label, 'Other files');
    });

    it('分级图标:含 error 级诊断标 error,纯 warning 事件标 warning', () => {
        const ts = new Date('2026-07-13T10:00:00Z').getTime();
        const mixedError: DebugEvent = {
            id: 'mix',
            type: 'compile_error',
            timestamp: ts,
            sessionId: 's1',
            workspaceId: 'ws',
            fileUri: 'file:///mixed.cpp',
            stderr: 'mixed',
            parsedErrors: [
                { raw: 'r1', file: 'a.cpp', line: 1, severity: 'error', message: 'e' },
                { raw: 'r2', file: 'a.cpp', line: 2, severity: 'warning', message: 'w' },
            ],
            exitCode: 1,
            durationMs: 10,
        };
        const pureWarning: DebugEvent = {
            id: 'warn-only',
            type: 'compile_error',
            timestamp: ts + 1_000,
            sessionId: 's1',
            workspaceId: 'ws',
            fileUri: 'file:///warnonly.cpp',
            stderr: 'warnonly',
            parsedErrors: [
                { raw: 'r', file: 'b.cpp', line: 1, severity: 'warning', message: 'w' },
            ],
            exitCode: 1,
            durationMs: 10,
        };
        const nodes = buildDebugJourneyNodes([mixedError, pureWarning]);

        // 文件按名称排序:mixed.cpp 在前,warnonly.cpp 在后;各一层日期+事件。
        const mixedNode = nodes[0].children[0].children[0];
        const warnNode = nodes[1].children[0].children[0];
        assert.strictEqual(mixedNode.type, 'compileErrorNode');
        assert.strictEqual(
            (mixedNode.iconPath as vscode.ThemeIcon).id,
            'error',
            '只要有 error 级诊断就用 error 图标'
        );
        assert.strictEqual(warnNode.type, 'compileErrorNode');
        assert.strictEqual(
            (warnNode.iconPath as vscode.ThemeIcon).id,
            'warning',
            '纯 warning 事件用 warning 图标'
        );
    });

    it('carries before/after snapshots on code modified nodes', () => {
        const ts = new Date('2026-07-13T10:00:00Z').getTime();
        const events: DebugEvent[] = [
            makeCodeModified('edit1', 'file:///main.cpp', ts, 'int x = 1', 'int x = 1;'),
        ];
        const nodes = buildDebugJourneyNodes(events);

        const editNode = nodes[0].children[0].children[0];
        assert.strictEqual(editNode.type, 'codeModifiedNode');
        assert.strictEqual(editNode.contextValue, 'codeModifiedNode');
        assert.ok(editNode.snapshot);
        assert.strictEqual(editNode.snapshot?.before, 'int x = 1');
        assert.strictEqual(editNode.snapshot?.after, 'int x = 1;');
    });

    it('computes changed line count label for edits', () => {
        const ts = new Date('2026-07-13T10:00:00Z').getTime();
        const events: DebugEvent[] = [
            makeCodeModified(
                'edit1',
                'file:///main.cpp',
                ts,
                'int x = 1\nreturn 0;',
                'int x = 1;\nreturn 0;'
            ),
        ];
        const nodes = buildDebugJourneyNodes(events);
        const editNode = nodes[0].children[0].children[0];
        assert.strictEqual(editNode.label, 'Edit (2 changed lines)');
    });

    it('produces unique and stable node IDs', () => {
        const ts = new Date('2026-07-13T10:00:00Z').getTime();
        const events: DebugEvent[] = [
            makeCompileError('e1', 'file:///main.cpp', ts, 'err'),
            makeCodeModified('edit1', 'file:///main.cpp', ts + 1000, 'a', 'b'),
        ];
        const nodesA = buildDebugJourneyNodes(events);
        const nodesB = buildDebugJourneyNodes(events);

        const idsA = nodesA.flatMap((n) => collectIds(n));
        const idsB = nodesB.flatMap((n) => collectIds(n));
        assert.deepStrictEqual(idsA, idsB);
        assert.strictEqual(new Set(idsA).size, idsA.length);
    });

    it('builds a diff tooltip with +/- markers', () => {
        const tooltip = buildDiffTooltip('int x = 1', 'int x = 1;');
        const text = tooltip.value;
        assert.ok(text.includes('- int x = 1'));
        assert.ok(text.includes('+ int x = 1;'));
    });

    it('sorts date buckets newest first and events oldest first within a day', () => {
        const day1 = new Date('2026-07-12T10:00:00Z').getTime();
        const day2 = new Date('2026-07-13T10:00:00Z').getTime();
        const events: DebugEvent[] = [
            makeCompileError('e1', 'file:///main.cpp', day2 + 2000, 'err'),
            makeCompileError('e2', 'file:///main.cpp', day1 + 1000, 'err'),
            makeCompileError('e3', 'file:///main.cpp', day2 + 1000, 'err'),
        ];
        const nodes = buildDebugJourneyNodes(events);
        assert.strictEqual(nodes[0].children.length, 2);
        assert.strictEqual(nodes[0].children[0].label, '2026-07-13');
        assert.strictEqual(nodes[0].children[1].label, '2026-07-12');

        const day2Events = nodes[0].children[0].children;
        assert.strictEqual(day2Events[0].eventId, 'e3');
        assert.strictEqual(day2Events[1].eventId, 'e1');
    });
});
