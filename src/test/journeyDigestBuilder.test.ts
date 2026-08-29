import * as assert from 'assert';
import { describe, it } from 'mocha';
import { buildJourneyDigest, formatRelativeAge } from '../chat/journeyDigestBuilder';
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

/** 固定本地时刻辅助:2026-08-28 12:00(本地时区),月按 0 基。 */
const NOW = new Date(2026, 7, 28, 12, 0, 0, 0).getTime();
const at = (month0: number, day: number, hours: number, minutes: number): number =>
    new Date(2026, month0, day, hours, minutes, 0, 0).getTime();

function compileErrorAt(id: string, timestamp: number, fileName: string, line: number): CompileErrorEvent {
    return compileError({
        id,
        timestamp,
        fileUri: `file:///w/${fileName}`,
        stderr: `${fileName}:${line}:5: error: x was not declared in this scope`,
        parsedErrors: [{
            raw: 'error: x was not declared in this scope',
            file: `file:///w/${fileName}`,
            line,
            severity: 'error',
            message: 'x was not declared in this scope',
        }],
    });
}

describe('formatRelativeAge 新鲜度标注口径', () => {
    it('同一自然日(含未来时间戳兜底) → 今天 HH:mm', () => {
        assert.strictEqual(formatRelativeAge(at(7, 28, 9, 30), NOW), '今天 09:30');
        assert.strictEqual(formatRelativeAge(at(7, 28, 0, 5), NOW), '今天 00:05');
        assert.strictEqual(formatRelativeAge(at(7, 28, 23, 59), NOW), '今天 23:59');
    });

    it('上一个自然日 → 昨天 HH:mm', () => {
        assert.strictEqual(formatRelativeAge(at(7, 27, 23, 5), NOW), '昨天 23:05');
    });

    it('距今 2–6 个自然日 → N 天前', () => {
        assert.strictEqual(formatRelativeAge(at(7, 26, 12, 0), NOW), '2 天前');
        assert.strictEqual(formatRelativeAge(at(7, 24, 0, 0), NOW), '4 天前');
        assert.strictEqual(formatRelativeAge(at(7, 22, 23, 0), NOW), '6 天前');
    });

    it('距今 ≥7 个自然日 → 绝对日期 M月D日(跨月按本地日期)', () => {
        assert.strictEqual(formatRelativeAge(at(7, 21, 12, 0), NOW), '8月21日');
        // 8月15日距今 13 个自然日,输出的是绝对日期本身而非天数差。
        assert.strictEqual(formatRelativeAge(at(7, 15, 0, 0), NOW), '8月15日');
        assert.strictEqual(formatRelativeAge(at(6, 20, 12, 0), NOW), '7月20日');
    });

    it('纯函数:同 (timestamp, nowMs) 恒定输出', () => {
        const ts = at(7, 25, 8, 15);
        assert.strictEqual(formatRelativeAge(ts, NOW), formatRelativeAge(ts, NOW));
    });
});

describe('buildJourneyDigest 新鲜度标注', () => {
    it('条目按口径标注今天/昨天/N 天前/M月D日,附在行尾全角括号内', () => {
        const digest = buildJourneyDigest([
            compileErrorAt('e-today', at(7, 28, 9, 30), 'today.cpp', 1),
            compileErrorAt('e-yesterday', at(7, 27, 18, 45), 'yesterday.cpp', 2),
            compileErrorAt('e-three', at(7, 25, 8, 0), 'three.cpp', 3),
            compileErrorAt('e-old', at(7, 10, 10, 0), 'old.cpp', 4),
        ], { nowMs: NOW });
        assert.ok(digest.includes('- today.cpp:1 变量/函数未声明 [编译错误]（今天 09:30）'));
        assert.ok(digest.includes('- yesterday.cpp:2 变量/函数未声明 [编译错误]（昨天 18:45）'));
        assert.ok(digest.includes('- three.cpp:3 变量/函数未声明 [编译错误]（3 天前）'));
        assert.ok(digest.includes('- old.cpp:4 变量/函数未声明 [编译错误]（8月10日）'));
    });

    it('免责句尾部追加最早/最新条目的时间跨度提示', () => {
        const digest = buildJourneyDigest([
            compileErrorAt('e-old', at(7, 10, 10, 0), 'old.cpp', 4),
            compileErrorAt('e-today', at(7, 28, 9, 30), 'today.cpp', 1),
        ], { nowMs: NOW });
        assert.match(digest, /Freshness: the oldest entry is from 8月10日, and the newest entry is from 今天 09:30\./);
        // 固定声明仍在,未破坏既有口径断言。
        assert.match(digest, /never invent details that are not listed/);
    });

    it('单条目时跨度句最早与最新同值(确定性边界)', () => {
        const digest = buildJourneyDigest(
            [compileErrorAt('only', at(7, 28, 9, 30), 'only.cpp', 1)],
            { nowMs: NOW }
        );
        assert.match(digest, /Freshness: the oldest entry is from 今天 09:30, and the newest entry is from 今天 09:30\./);
    });

    it('nowMs 注入下输出逐字节确定,且改 nowMs 会改变标注(不依赖真实时钟)', () => {
        const events: DebugEvent[] = [
            compileErrorAt('ce', at(7, 27, 9, 0), 'main.cpp', 12),
            runError({ timestamp: at(7, 26, 21, 10) }),
        ];
        const a = buildJourneyDigest(events, { nowMs: NOW });
        const b = buildJourneyDigest(events, { nowMs: NOW });
        assert.strictEqual(a, b);
        const later = buildJourneyDigest(events, { nowMs: NOW + 40 * 86_400_000 });
        assert.notStrictEqual(a, later);
    });

    it('标注字符计入字符预算:贴边用例下截断点因标注后移', () => {
        // 两条未匹配知识 pattern 的编译错误(无错题卡干扰),同节两条。
        // 刻意用不同文件:同文件的下一次编译会让旧错误被生命周期判定为
        // 「已消失即解决」(errorLifecycle 既有语义),条目就不剩两条了。
        const events: DebugEvent[] = [
            compileError({
                id: 'u-old',
                timestamp: at(7, 26, 9, 0),
                fileUri: 'file:///w/oldmsg.cpp',
                stderr: 'oldmsg.cpp:5:5: error: zz-alpha-unknown-diagnostic',
                parsedErrors: [{
                    raw: 'error: zz-alpha-unknown-diagnostic',
                    file: 'file:///w/oldmsg.cpp',
                    line: 5,
                    severity: 'error',
                    message: 'zz-alpha-unknown-diagnostic',
                }],
            }),
            compileError({
                id: 'u-new',
                timestamp: at(7, 27, 9, 0),
                fileUri: 'file:///w/newmsg.cpp',
                stderr: 'newmsg.cpp:6:5: error: zz-beta-unknown-diagnostic',
                parsedErrors: [{
                    raw: 'error: zz-beta-unknown-diagnostic',
                    file: 'file:///w/newmsg.cpp',
                    line: 6,
                    severity: 'error',
                    message: 'zz-beta-unknown-diagnostic',
                }],
            }),
        ];
        const full = buildJourneyDigest(events, { nowMs: NOW });
        const fullItems = full.split('\n').filter((line) => line.startsWith('- '));
        assert.strictEqual(fullItems.length, 2);
        const lastItem = fullItems[fullItems.length - 1];
        const ann = lastItem.match(/（[^（）]*）$/);
        assert.ok(ann, '条目行应以相对时间标注结尾');
        // 预算 = 整块长度 - 末条标注长度:若标注计入预算,末条恰好放不下。
        const budget = full.length - ann[0].length;
        const tight = buildJourneyDigest(events, { nowMs: NOW, maxChars: budget });
        const tightItems = tight.split('\n').filter((line) => line.startsWith('- '));
        assert.strictEqual(tightItems.length, 1);
        assert.ok(!tight.includes(lastItem));
        assert.ok(tight.length <= budget);
    });

    it('每条条目行以标注结尾;剥掉标注后的长度作预算会截掉条目(标注计入预算)', () => {
        const events: DebugEvent[] = [];
        for (let i = 0; i < 3; i++) {
            events.push(compileErrorAt(`e-${i}`, at(7, 26 - i, 10, 0), `g${i}.cpp`, i + 1));
        }
        const full = buildJourneyDigest(events, { nowMs: NOW });
        const fullItems = full.split('\n').filter((line) => line.startsWith('- '));
        assert.ok(fullItems.length >= 3);
        for (const line of fullItems) {
            assert.match(line, /（[^（）]*）$/);
        }
        const stripped = full.replace(/（[^（）\n]*）$/gm, '');
        assert.ok(stripped.length < full.length);
        const tight = buildJourneyDigest(events, { nowMs: NOW, maxChars: stripped.length });
        const tightItems = tight.split('\n').filter((line) => line.startsWith('- '));
        assert.ok(tightItems.length < fullItems.length, '无标注口径的预算装不下带标注条目');
        assert.ok(tight.length <= stripped.length);
    });
});
