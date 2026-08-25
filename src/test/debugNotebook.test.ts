import * as assert from 'assert';
import { describe, it } from 'mocha';
import type { JourneySummary } from '../debug/debugJourneySummary';
import type { DebugJourneyStore } from '../debug/debugJourneyStore';
import type { KnowledgeCard } from '../debug/knowledgeCard';
import type { RunErrorEvent } from '../debug/types';
import {
    buildNotebookInput,
    buildNotebookPrompt,
    formatNotebookFallback,
    type DebugNotebookInput,
} from '../debug/debugNotebook';
import { formatFixWithContext } from '../debug/formatDiff';

function makeSummary(): JourneySummary {
    return {
        workspaceId: 'ws',
        totalEvents: 4,
        errorStats: {
            totalCompileErrors: 1,
            totalCompileSuccesses: 1,
            totalRunErrors: 0,
            byErrorCode: {},
            byKnowledgeTag: { missing_semicolon: 1 },
            byFile: {},
            bySeverity: {},
        },
        hintStats: {
            totalHints: 1,
            byIntent: { error_explanation: 1 },
            avgHintsBeforeSuccess: 1,
            unresolvedHintRatio: 0,
        },
        timeStats: {
            totalCompileDurationMs: 100,
            avgCompileDurationMs: 100,
            medianCompileDurationMs: 100,
        },
        metrics: {
            errorRate: 0.5,
            repeatedErrorDensity: 0,
            helpSeekingRatio: 1,
            independentFixRatio: 0,
            avgFixAttempts: 1,
        },
        conceptProfiles: [
            {
                tag: 'missing_semicolon',
                occurrenceCount: 1,
                resolvedCount: 1,
                unresolvedCount: 0,
                avgFixAttempts: 1,
                lastSeenAt: 1000,
            },
        ],
        lifecycles: [],
        sessionStats: [],
        suggestedSteps: ['Check semicolons before return statements.'],
    };
}

function makeCard(): KnowledgeCard {
    return {
        tag: 'missing_semicolon',
        title: 'Missing semicolon',
        summary: 'A statement is missing its terminating semicolon.',
        commonCauses: ['Forgot to type `;` at the end of a statement.'],
        suggestedFixes: ['Add a semicolon at the end of the statement.'],
        checkMethod: 'Read each statement until the next line.',
        wrongExample: 'int x = 1\nreturn 0;',
        correctExample: 'int x = 1;\nreturn 0;',
        frequency: 1,
        resolvedCount: 1,
        unresolvedCount: 0,
        avgFixAttempts: 1,
        lastSeenAt: 1000,
        sourceEvents: ['e1'],
        correctingEditIds: ['edit1'],
        concreteFixes: [
            {
                before: 'int x = 1\nreturn 0;',
                after: 'int x = 1;\nreturn 0;',
                diff: '- int x = 1\n+ int x = 1;',
            },
        ],
    };
}

function makeRuntimeCard(): KnowledgeCard {
    return {
        tag: 'runtime_unknown',
        title: '原因尚不明确的运行错误',
        summary: '程序没有正常结束，但现有证据不足以唯一判断成因。',
        commonCauses: ['现有证据不足，不能诚实地把问题归到某一种具体原因'],
        suggestedFixes: ['保留完整运行输出和退出码'],
        checkMethod: '拿到新增证据后再判断具体原因。',
        wrongExample: '// 只有异常退出这一事实，不能猜出具体出错语句',
        correctExample: '// 先记录输入、stdout、stderr 与退出码',
        frequency: 1,
        resolvedCount: 0,
        unresolvedCount: 1,
        avgFixAttempts: 0,
        lastSeenAt: 2_000,
        sourceEvents: ['run-1'],
        correctingEditIds: [],
        concreteFixes: [],
        phenomenon: '运行出错：原因不明(退出码 134)；程序抛出了 MyError',
        fileUri: 'file:///w/main.exe',
        problemKey: 'main',
        severity: 'error',
    };
}

function makeInput(): DebugNotebookInput {
    return {
        workspaceId: 'ws',
        generatedAt: new Date('2026-07-13T10:00:00Z').toISOString(),
        summary: makeSummary(),
        cards: [makeCard()],
    };
}

describe('Debug Notebook', () => {
    it('builds a prompt with system and user messages', () => {
        const input = makeInput();
        const prompt = buildNotebookPrompt(input);

        assert.strictEqual(prompt.messages.length, 2);
        assert.strictEqual(prompt.messages[0].role, 'system');
        assert.ok(prompt.messages[0].content.includes('错题本'));
        assert.strictEqual(prompt.messages[1].role, 'user');
        assert.ok(prompt.messages[1].content.includes('ws'));
        assert.ok(prompt.estimatedInputTokens > 0);
    });

    it('limits cards and fixes according to options', () => {
        const input = makeInput();
        input.cards = [makeCard(), makeCard(), makeCard()];
        const prompt = buildNotebookPrompt(input, { maxCards: 2, maxFixesPerCard: 1 });

        const userContent = prompt.messages[1].content;
        const cardMatches = userContent.match(/"title":\s*"Missing semicolon"/g);
        assert.ok(cardMatches);
        assert.strictEqual(cardMatches.length, 2);
    });

    it('fallback markdown includes title, stats, and card diff', () => {
        const input = makeInput();
        const markdown = formatNotebookFallback(input);

        assert.ok(markdown.includes('# ClassMate Debug 错题本'));
        assert.ok(markdown.includes('总事件数：4'));
        assert.ok(markdown.includes('Missing semicolon'));
        assert.ok(markdown.includes('```diff'));
        assert.ok(markdown.includes('- int x = 1'));
        assert.ok(markdown.includes('+ int x = 1;'));
        assert.ok(markdown.includes('Check semicolons before return statements.'));
    });

    it('Notebook prompt 与 fallback 明确携带运行卡事实现象，且没有伪造 concrete diff', () => {
        const input = makeInput();
        input.cards = [makeRuntimeCard()];

        const prompt = buildNotebookPrompt(input);
        const userContent = prompt.messages[1].content;
        assert.ok(userContent.includes('"phenomenon": "运行出错：原因不明(退出码 134)；程序抛出了 MyError"'));
        assert.ok(userContent.includes('"concreteFixes": []'));
        assert.ok(!userContent.includes('```diff'));
        assert.ok(!userContent.includes('"fileUri"'), '本地文件 URI 不得进入 LLM prompt');
        assert.ok(!userContent.includes('file:///w/main.exe'), '本地绝对路径不得外发');

        const markdown = formatNotebookFallback(input);
        assert.ok(markdown.includes('**错误现象：** 运行出错：原因不明(退出码 134)；程序抛出了 MyError'));
        assert.ok(markdown.includes('**概念反例（教学示例，不是你的代码）：**'));
        assert.ok(markdown.includes('**概念正例（教学示例，不是你的修复）：**'));
        assert.ok(!markdown.includes('**真实修复示例：**'));
        assert.ok(!markdown.includes('```diff'));
    });

    it('buildNotebookInput 从 store 生成运行知识卡并带入 Markdown 输入', async () => {
        const event: RunErrorEvent = {
            id: 'stored-run',
            type: 'run_error',
            timestamp: 1_000,
            sessionId: 'session',
            workspaceId: 'ws',
            fileUri: 'file:///w/main.exe',
            executablePath: 'C:/w/main.exe',
            stdout: '',
            stderr: 'Assertion failed: n > 0',
            exitCode: 3,
            durationMs: 100,
            kind: 'runtime_assertion_failed',
        };
        const store = {
            workspaceId: 'ws',
            getEvents: async () => [event],
            getResolvedMarks: async () => ({}),
        } as unknown as DebugJourneyStore;

        const input = await buildNotebookInput(store);

        assert.strictEqual(input.cards.length, 1);
        assert.strictEqual(input.cards[0].tag, 'runtime_assertion_failed');
        assert.match(input.cards[0].phenomenon ?? '', /断言失败/);
        assert.match(formatNotebookFallback(input), /错误现象.*断言失败/);
    });

    it('context diff preserves unchanged lines around changes', () => {
        const before = 'int a = 1;\nint x = 1\nreturn 0;\nint b = 2;';
        const after = 'int a = 1;\nint x = 1;\nreturn 0;\nint b = 2;';
        const diff = formatFixWithContext(before, after, 1);

        assert.ok(diff.includes('int a = 1;'));
        assert.ok(diff.includes('- int x = 1'));
        assert.ok(diff.includes('+ int x = 1;'));
        assert.ok(diff.includes('return 0;'));
    });

    it('context diff omits distant unchanged lines', () => {
        const before = 'line0\nline1\nline2\nline3\nline4\nbug\nline6\nline7\nline8\nline9';
        const after = 'line0\nline1\nline2\nline3\nline4\nfixed\nline6\nline7\nline8\nline9';
        const diff = formatFixWithContext(before, after, 1);

        assert.ok(diff.includes('line4'));
        assert.ok(diff.includes('- bug'));
        assert.ok(diff.includes('+ fixed'));
        assert.ok(diff.includes('line6'));
        // line0 and line9 are outside the context window.
        assert.ok(!diff.includes('line0'));
        assert.ok(!diff.includes('line9'));
    });
});
