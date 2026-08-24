import * as assert from 'assert';
import { describe, it } from 'mocha';
import { buildJourneyDigest } from '../chat/journeyDigestBuilder';
import type {
    CompileErrorEvent,
    DebugEvent,
    RunErrorEvent,
} from '../debug/types';

function compileError(overrides: Partial<CompileErrorEvent> = {}): CompileErrorEvent {
    return {
        id: 'err-1',
        type: 'compile_error',
        timestamp: 1_000,
        sessionId: 'session',
        workspaceId: 'ws',
        fileUri: 'file:///w/main.cpp',
        stderr: 'main.cpp:12:5: error: x was not declared in this scope',
        parsedErrors: [
            {
                raw: 'error: x was not declared in this scope',
                file: 'file:///w/main.cpp',
                line: 12,
                severity: 'error',
                message: 'x was not declared in this scope',
            },
        ],
        exitCode: 1,
        durationMs: 800,
        ...overrides,
    };
}

function runError(overrides: Partial<RunErrorEvent> = {}): RunErrorEvent {
    return {
        id: 'run-bad-1',
        type: 'run_error',
        timestamp: 4_000,
        sessionId: 'session',
        workspaceId: 'ws',
        fileUri: 'file:///w/main.exe',
        executablePath: 'C:/w/main.exe',
        stdout: '',
        stderr: 'Segmentation fault (core dumped)',
        exitCode: 139,
        durationMs: 90,
        kind: 'runtime_segmentation_fault',
        ...overrides,
    };
}

describe('buildJourneyDigest', () => {
    it('空数据返回空字符串(不得产出占位块)', () => {
        assert.strictEqual(buildJourneyDigest([]), '');
    });

    it('未解决编译错误含文件、行号、概念标签与级别分类', () => {
        const digest = buildJourneyDigest([compileError()]);
        assert.match(digest, /Student debugging history digest/);
        assert.match(digest, /never invent details that are not listed/);
        assert.match(digest, /Unresolved compile errors:/);
        assert.match(digest, /- main\.cpp:12 变量\/函数未声明 \[编译错误\]/);
    });

    it('未解决运行错误带 kind 学生化文案与可执行文件名', () => {
        const digest = buildJourneyDigest([
            compileError(),
            runError({ timestamp: 4_000 }),
        ]);
        assert.match(digest, /Unresolved run errors:/);
        assert.match(digest, /- 运行出错：非法内存访问\(段错误\)\(退出码 139\) \[main\.exe\]/);
    });

    it('错题模式给出去重概念标签与出现次数', () => {
        const digest = buildJourneyDigest([
            compileError(),
            compileError({
                id: 'err-2',
                timestamp: 9_000,
                fileUri: 'file:///w/main.cpp',
                stderr: 'main.cpp:30:5: error: y was not declared in this scope',
                parsedErrors: [{
                    raw: 'error: y was not declared in this scope',
                    file: 'file:///w/main.cpp',
                    line: 30,
                    severity: 'error',
                    message: 'y was not declared in this scope',
                }],
            }),
        ]);
        assert.match(digest, /Recurring mistake patterns:/);
        // 同一标签去重合并:出现次数 ×2(未解决计数按上游生命周期口径)。
        assert.match(digest, /- 变量\/函数未声明 ×2\(\d+ 次未解决\)/);
    });

    it('已解决的编译错误不再出现在未解决清单(错题模式保留)', () => {
        const digest = buildJourneyDigest([
            compileError(),
            {
                id: 'edit-1',
                type: 'code_modified',
                timestamp: 2_000,
                sessionId: 'session',
                workspaceId: 'ws',
                fileUri: 'file:///w/main.cpp',
                before: 'int main() {\n    x\n}',
                after: 'int main() {\n    int x;\n}',
                diff: '-    x\n+    int x;',
                trigger: 'manual',
            },
            {
                id: 'ok-1',
                type: 'compile_success',
                timestamp: 3_000,
                sessionId: 'session',
                workspaceId: 'ws',
                fileUri: 'file:///w/main.cpp',
                exitCode: 0,
                durationMs: 700,
            },
        ]);
        assert.doesNotMatch(digest, /Unresolved compile errors:/);
        assert.doesNotMatch(digest, /main\.cpp:12/);
    });

    it('措辞不含内部术语', () => {
        const digest = buildJourneyDigest([compileError(), runError()]);
        assert.doesNotMatch(digest, /信封|envelope|Frozen workspace data|清单|checklist/i);
    });

    it('当前打开文件相关的条目排在其余条目前面', () => {
        const events: DebugEvent[] = [
            compileError(),
            compileError({
                id: 'err-other',
                timestamp: 8_000,
                fileUri: 'file:///w/other.cpp',
                stderr: 'other.cpp:7:10: error: expected \';\' before \u2019return\u2019',
                parsedErrors: [{
                    raw: "error: expected ';' before 'return'",
                    file: 'file:///w/other.cpp',
                    line: 7,
                    severity: 'error',
                    message: "expected ';' before 'return'",
                }],
            }),
        ];
        const digest = buildJourneyDigest(events, { currentFilePath: 'file:///w/main.cpp' });
        const mainIndex = digest.indexOf('main.cpp:12');
        const otherIndex = digest.indexOf('other.cpp:7');
        assert.ok(mainIndex !== -1 && otherIndex !== -1);
        assert.ok(mainIndex < otherIndex, '当前文件条目应先于其他文件条目');
    });

    it('超出字符预算时截断且总长不超过上限', () => {
        const events: DebugEvent[] = [];
        for (let i = 0; i < 6; i++) {
            events.push(compileError({
                id: `err-${i}`,
                timestamp: 1_000 + i * 1_000,
                fileUri: 'file:///w/main.cpp',
                stderr: `main.cpp:${10 + i}:5: error: v${i} was not declared in this scope`,
                parsedErrors: [{
                    raw: `error: v${i} was not declared in this scope`,
                    file: 'file:///w/main.cpp',
                    line: 10 + i,
                    severity: 'error',
                    message: `v${i} was not declared in this scope`,
                }],
            }));
        }
        const full = buildJourneyDigest(events);
        const fullLines = full.split('\n');
        const firstItemIndex = fullLines.findIndex((line) => line.startsWith('- '));
        assert.ok(firstItemIndex > 0);
        // 预算收紧到「标题 + 第一条」:只应保留一条,且总长不超预算。
        const budget = fullLines.slice(0, firstItemIndex + 1).join('\n').length;
        const tight = buildJourneyDigest(events, { maxChars: budget });
        const tightItems = tight.split('\n').filter((line) => line.startsWith('- '));
        assert.strictEqual(tightItems.length, 1);
        assert.ok(tight.length <= budget);

        assert.strictEqual(buildJourneyDigest(events, { maxChars: 0 }), '');
    });

    it('每节条数有兜底上限,防止单节独占', () => {
        const events: DebugEvent[] = [];
        for (let i = 0; i < 8; i++) {
            events.push(compileError({
                id: `err-${i}`,
                timestamp: 1_000 + i * 1_000,
                fileUri: `file:///w/f${i}.cpp`,
                stderr: `f${i}.cpp:5:5: error: v${i} was not declared in this scope`,
                parsedErrors: [{
                    raw: `error: v${i} was not declared in this scope`,
                    file: `file:///w/f${i}.cpp`,
                    line: 5,
                    severity: 'error',
                    message: `v${i} was not declared in this scope`,
                }],
            }));
        }
        const digest = buildJourneyDigest(events, { currentFilePath: 'file:///w/f0.cpp' });
        const compileLines = digest.split('\n')
            .filter((line) => /^- f\d+\.cpp/.test(line));
        assert.strictEqual(compileLines.length, 5);
        // 相关文件即使最旧也必须保留在截断前列。
        assert.match(digest, /f0\.cpp:5/);
    });
});
