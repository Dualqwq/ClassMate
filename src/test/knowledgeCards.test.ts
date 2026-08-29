import * as assert from 'assert';
import { describe, it } from 'mocha';
import {
    generateKnowledgeCard,
    mergeKnowledgeCards,
    sortKnowledgeCards,
    mergeAndSortKnowledgeCards,
    type KnowledgeCard,
} from '../debug/knowledgeCard';
import { getKnowledgeConcept, listKnowledgeConcepts, matchErrorToKnowledge } from '../error/errorKnowledgeMap';
import { extractErrorLocation } from '../error/errorParser';
import type { CompileErrorEvent, DebugEvent, CodeModifiedEvent, CompileSuccessEvent } from '../debug/types';
import { buildErrorLifecycles } from '../debug/errorLifecycle';

function makeCompileError(
    id: string,
    message: string,
    timestamp = 0
): CompileErrorEvent {
    return {
        id,
        type: 'compile_error',
        timestamp,
        sessionId: 's1',
        workspaceId: 'ws',
        fileUri: 'file:///main.cpp',
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
    before: string,
    after: string,
    timestamp = 0
): CodeModifiedEvent {
    return {
        id,
        type: 'code_modified',
        timestamp,
        sessionId: 's1',
        workspaceId: 'ws',
        fileUri: 'file:///main.cpp',
        before,
        after,
        diff: '', // tests should rely on formatDiff, not the stored diff field
        trigger: 'manual',
    };
}

function makeCompileSuccess(id: string, timestamp = 0): CompileSuccessEvent {
    return {
        id,
        type: 'compile_success',
        timestamp,
        sessionId: 's1',
        workspaceId: 'ws',
        fileUri: 'file:///main.cpp',
        exitCode: 0,
        durationMs: 100,
    };
}

describe('knowledge cards', () => {
    it('covers all patterns with non-empty concept metadata', () => {
        const concepts = listKnowledgeConcepts();
        // 12 个 C/C++ 编译概念 + P0 新增 6 个(operator_operand_mismatch / lvalue_required /
        // array_out_of_bounds / overload_ambiguous / control_flow_return /
        // pointer_dereference_mismatch) + 2 个 make 类概念(#8) + member_not_found
        // (has no member named 家族,含 ERROR_PATTERNS 条目) + P5b 新增 6 个
        // 模板/STL 概念(iterator_category_mismatch / comparator_not_defined /
        // map_value_type_const / stream_output_operator / dependent_name_typename /
        // vector_bool_proxy,只经签名表命中,无 ERROR_PATTERNS 条目)。
        assert.strictEqual(concepts.length, 27);
        for (const concept of concepts) {
            assert.ok(concept.title.length > 0, `${concept.tag} title empty`);
            assert.ok(concept.summary.length > 0, `${concept.tag} summary empty`);
            assert.ok(concept.commonCauses.length > 0, `${concept.tag} commonCauses empty`);
            assert.ok(concept.suggestedFixes.length > 0, `${concept.tag} suggestedFixes empty`);
            assert.ok(concept.checkMethod.length > 0, `${concept.tag} checkMethod empty`);
            assert.ok(concept.wrongExample.length > 0, `${concept.tag} wrongExample empty`);
            assert.ok(concept.correctExample.length > 0, `${concept.tag} correctExample empty`);
            assert.strictEqual(getKnowledgeConcept(concept.tag)?.tag, concept.tag);
        }
    });

    it('keeps P0 teaching examples aligned with their diagnostic concepts', () => {
        const cases: Array<{
            tag: string;
            wrongFragment: string;
            correctFragment: string;
        }> = [
            {
                tag: 'operator_operand_mismatch',
                wrongFragment: 'std::string label = x << "岁";',
                correctFragment: 'std::string label = std::to_string(x) + "岁";',
            },
            {
                tag: 'lvalue_required',
                wrongFragment: 'a + b = c;',
                correctFragment: 'c = a + b;',
            },
            {
                tag: 'array_out_of_bounds',
                wrongFragment: 'i <= 5',
                correctFragment: 'i < 5',
            },
            {
                tag: 'overload_ambiguous',
                wrongFragment: 'f(1L);',
                correctFragment: 'f(1);',
            },
            {
                tag: 'control_flow_return',
                wrongFragment: 'if (a > b)',
                correctFragment: 'return b;',
            },
            {
                tag: 'pointer_dereference_mismatch',
                wrongFragment: 's->x = 1;',
                correctFragment: 's.x = 1;',
            },
        ];

        for (const testCase of cases) {
            const concept = getKnowledgeConcept(testCase.tag);
            assert.ok(concept, `${testCase.tag} concept missing`);
            assert.ok(
                concept.wrongExample.includes(testCase.wrongFragment),
                `${testCase.tag} wrongExample must demonstrate ${testCase.wrongFragment}`
            );
            assert.ok(
                concept.correctExample.includes(testCase.correctFragment),
                `${testCase.tag} correctExample must demonstrate ${testCase.correctFragment}`
            );
        }
    });

    it('does not teach that valid pointer subscripting is illegal', () => {
        const concept = getKnowledgeConcept('pointer_dereference_mismatch');
        assert.ok(concept);
        assert.ok(!concept.summary.includes('以数组方式解引用指针都会报错'));
        assert.ok(!concept.summary.includes('对非指针、非数组值使用 -> 或 [] 会报错'));
        assert.ok(concept.summary.includes('合法指针、数组以及支持 operator[] 的类型都可以使用 []'));
        assert.ok(concept.summary.includes('对不支持相应成员或下标运算的类型使用 -> 或 [] 会报错'));
        assert.strictEqual(concept.commonCauses[2], '对不支持下标运算的类型使用 []');
        assert.strictEqual(concept.suggestedFixes[2], '使用 [] 前确认该类型支持下标运算');
    });

    it('does not classify a non-operator no-match diagnostic as an operand mismatch', () => {
        const matches = matchErrorToKnowledge("no match for call to 'foo'");
        assert.ok(!matches.some((match) => match.tag === 'operator_operand_mismatch'));
    });

    it('generates a card for a single matching compile error', () => {
        const event = makeCompileError('e1', "expected ';' before 'return'");
        const events: DebugEvent[] = [event];
        const lifecycles = buildErrorLifecycles(events);
        const cards = generateKnowledgeCard(event, events, lifecycles);

        assert.strictEqual(cards.length, 1);
        assert.strictEqual(cards[0].tag, 'missing_semicolon');
        assert.strictEqual(cards[0].title, '缺少分号或语句结束符');
        assert.strictEqual(cards[0].frequency, 1);
        assert.strictEqual(cards[0].unresolvedCount, 1);
        assert.strictEqual(cards[0].resolvedCount, 0);
        assert.strictEqual(cards[0].sourceEvents[0], 'e1');
    });

    it('returns an empty array for unmatched errors', () => {
        const event = makeCompileError('e1', 'some weird unknown diagnostic');
        const events: DebugEvent[] = [event];
        const lifecycles = buildErrorLifecycles(events);
        const cards = generateKnowledgeCard(event, events, lifecycles);
        assert.strictEqual(cards.length, 0);
    });

    it('generates cards for common errors missed before P0 patterns', () => {
        // 研究文档 §3.2 实测 13 MISS 中的代表样本,P0 后应能入卡。
        const cases: { message: string; expectedTag: string }[] = [
            { message: "lvalue required as left operand of assignment", expectedTag: 'lvalue_required' },
            { message: "control reaches end of non-void function", expectedTag: 'control_flow_return' },
            { message: "base operand of '->' has non-pointer type", expectedTag: 'pointer_dereference_mismatch' },
        ];
        for (const c of cases) {
            const event = makeCompileError('e1', c.message);
            const events: DebugEvent[] = [event];
            const lifecycles = buildErrorLifecycles(events);
            const cards = generateKnowledgeCard(event, events, lifecycles);
            assert.strictEqual(cards.length, 1, `expected one card for "${c.message}"`);
            assert.strictEqual(cards[0].tag, c.expectedTag);
        }
    });

    it('generates a member_not_found card for a has-no-member diagnostic', () => {
        // 2026-08-29 用户实测漏网:该家族此前不命中任何 pattern,错题本无知识标签。
        const event = makeCompileError(
            'e1',
            "'class std::vector<int>' has no member named 'pushback'; did you mean 'push_back'?"
        );
        const events: DebugEvent[] = [event];
        const lifecycles = buildErrorLifecycles(events);
        const cards = generateKnowledgeCard(event, events, lifecycles);

        assert.strictEqual(cards.length, 1);
        assert.strictEqual(cards[0].tag, 'member_not_found');
        assert.strictEqual(cards[0].title, '类中没有这个成员名');
    });

    it('merges cards by tag and sums frequency', () => {
        const event1 = makeCompileError('e1', "expected ';' before 'return'", 1000);
        const event2 = makeCompileError('e2', "expected ';' after expression", 2000);
        const events: DebugEvent[] = [event1, event2];
        const lifecycles = buildErrorLifecycles(events);
        const cards = [
            ...generateKnowledgeCard(event1, events, lifecycles),
            ...generateKnowledgeCard(event2, events, lifecycles),
        ];
        const merged = mergeKnowledgeCards(cards);

        assert.strictEqual(merged.length, 1);
        assert.strictEqual(merged[0].tag, 'missing_semicolon');
        assert.strictEqual(merged[0].frequency, 2);
    });

    it('extracts concrete fixes with before/after/diff from fixing edits', () => {
        const errorEvent = makeCompileError('e1', "expected ';' before 'return'", 1000);
        const editEvent = makeCodeModified('edit1', 'int x = 1\nreturn 0;', 'int x = 1;\nreturn 0;', 1500);
        const successEvent = makeCompileSuccess('s1', 2000);
        const events: DebugEvent[] = [errorEvent, editEvent, successEvent];
        const lifecycles = buildErrorLifecycles(events);
        const cards = generateKnowledgeCard(errorEvent, events, lifecycles);

        assert.strictEqual(cards.length, 1);
        assert.strictEqual(cards[0].correctingEditIds[0], 'edit1');
        assert.strictEqual(cards[0].concreteFixes.length, 1);
        const fix = cards[0].concreteFixes[0];
        assert.strictEqual(fix.before, 'int x = 1\nreturn 0;');
        assert.strictEqual(fix.after, 'int x = 1;\nreturn 0;');
        assert.ok(fix.diff.includes('- int x = 1'));
        assert.ok(fix.diff.includes('+ int x = 1;'));
    });

    it('deduplicates concrete fixes by before/after pair', () => {
        const errorEvent = makeCompileError('e1', "expected ';' before 'return'", 1000);
        const editEvent1 = makeCodeModified('edit1', 'int x = 1', 'int x = 1;', 1500);
        const editEvent2 = makeCodeModified('edit2', 'int x = 1', 'int x = 1;', 1600);
        const successEvent = makeCompileSuccess('s1', 2000);
        const events: DebugEvent[] = [errorEvent, editEvent1, editEvent2, successEvent];
        const lifecycles = buildErrorLifecycles(events);
        const cards = generateKnowledgeCard(errorEvent, events, lifecycles);

        assert.strictEqual(cards.length, 1);
        // Two edits with identical (before, after) should collapse to one concrete fix.
        assert.strictEqual(cards[0].concreteFixes.length, 1);
    });

    it('sorts cards by unresolved count first', () => {
        const cardA: KnowledgeCard = {
            tag: 'missing_semicolon',
            title: 'Missing semicolon',
            summary: '...',
            commonCauses: [],
            suggestedFixes: [],
            checkMethod: '',
            wrongExample: '',
            correctExample: '',
            frequency: 5,
            resolvedCount: 5,
            unresolvedCount: 0,
            avgFixAttempts: 1,
            lastSeenAt: 1000,
            sourceEvents: [],
            correctingEditIds: [],
            concreteFixes: [],
        };
        const cardB: KnowledgeCard = {
            tag: 'undeclared_identifier',
            title: 'Undeclared identifier',
            summary: '...',
            commonCauses: [],
            suggestedFixes: [],
            checkMethod: '',
            wrongExample: '',
            correctExample: '',
            frequency: 1,
            resolvedCount: 0,
            unresolvedCount: 1,
            avgFixAttempts: 1,
            lastSeenAt: 500,
            sourceEvents: [],
            correctingEditIds: [],
            concreteFixes: [],
        };
        const sorted = sortKnowledgeCards([cardA, cardB]);
        assert.strictEqual(sorted[0].tag, 'undeclared_identifier');
        assert.strictEqual(sorted[1].tag, 'missing_semicolon');
    });

    it('merges and sorts in one call', () => {
        const event1 = makeCompileError('e1', "expected ';' before 'return'", 1000);
        const event2 = makeCompileError('e2', "expected ';' after expression", 2000);
        const event3 = makeCompileError('e3', "x was not declared in this scope", 3000);
        const events: DebugEvent[] = [event1, event2, event3];
        const lifecycles = buildErrorLifecycles(events);
        const cards = events
            .filter((e) => e.type === 'compile_error')
            .flatMap((e) => generateKnowledgeCard(e as CompileErrorEvent, events, lifecycles));

        const merged = mergeAndSortKnowledgeCards(cards);
        assert.strictEqual(merged.length, 2);
        // undeclared_identifier is unresolved, so it ranks above the resolved
        // missing_semicolon cards despite their higher frequency.
        assert.strictEqual(merged[0].tag, 'undeclared_identifier');
        assert.strictEqual(merged[0].frequency, 1);
        assert.strictEqual(merged[0].unresolvedCount, 1);
        assert.strictEqual(merged[1].tag, 'missing_semicolon');
        assert.strictEqual(merged[1].frequency, 2);
        assert.strictEqual(merged[1].resolvedCount, 2);
    });

    it('computes weighted average fix attempts after merge', () => {
        const event1 = makeCompileError('e1', "expected ';' before 'return'", 1000);
        const event2 = makeCompileError('e2', "expected ';' after expression", 2000);
        const editEvent1 = makeCodeModified('edit1', 'int a', 'int a;', 1500);
        const successEvent1 = makeCompileSuccess('s1', 1600);
        const editEvent2 = makeCodeModified('edit2', 'int b', 'int b;', 2500);
        const successEvent2 = makeCompileSuccess('s2', 2600);
        const events: DebugEvent[] = [
            event1,
            editEvent1,
            successEvent1,
            event2,
            editEvent2,
            successEvent2,
        ];
        const lifecycles = buildErrorLifecycles(events);
        const cards = events
            .filter((e) => e.type === 'compile_error')
            .flatMap((e) => generateKnowledgeCard(e as CompileErrorEvent, events, lifecycles));
        const merged = mergeKnowledgeCards(cards);

        assert.strictEqual(merged.length, 1);
        // Each error resolved in 1 attempt, so weighted average is 1.
        assert.strictEqual(merged[0].avgFixAttempts, 1);
    });

    it('matches expected tags for common compiler messages', () => {
        const cases: { message: string; expectedTag: string }[] = [
            { message: "expected ';' before 'return'", expectedTag: 'missing_semicolon' },
            { message: "'x' was not declared in this scope", expectedTag: 'undeclared_identifier' },
            { message: 'no matching function for call to foo', expectedTag: 'function_call_mismatch' },
            { message: 'cannot convert int to char*', expectedTag: 'type_conversion' },
            { message: 'undefined reference to bar', expectedTag: 'undefined_reference' },
            { message: 'multiple definition of baz', expectedTag: 'multiple_definition' },
            { message: 'invalid use of non-static member', expectedTag: 'non_static_member' },
            { message: "'x' is private within this context", expectedTag: 'private_access' },
            { message: 'Segmentation fault', expectedTag: 'segmentation_fault' },
            { message: 'expected identifier', expectedTag: 'syntax_punctuation' },
            { message: 'cannot find -lm', expectedTag: 'missing_library' },
            { message: 'no such file or directory', expectedTag: 'missing_header' },
            { message: "'missing.h' file not found", expectedTag: 'missing_header' },
            // P0 新增 pattern 的 stderr 样本(每条新增正则至少一条):
            { message: "invalid operands of types 'int' and 'const char [2]' to binary 'operator<<'", expectedTag: 'operator_operand_mismatch' },
            { message: "invalid operands to binary expression ('int' and 'const char[4]')", expectedTag: 'operator_operand_mismatch' },
            { message: "no match for 'operator<<' (operand types are 'std::ostream' and 'const char [2]')", expectedTag: 'operator_operand_mismatch' },
            { message: "lvalue required as left operand of assignment", expectedTag: 'lvalue_required' },
            { message: 'array subscript out of bounds', expectedTag: 'array_out_of_bounds' },
            { message: 'subscript out of range', expectedTag: 'array_out_of_bounds' },
            { message: "reference to 'count' is ambiguous", expectedTag: 'overload_ambiguous' },
            { message: 'candidate expects 2 arguments, 1 provided', expectedTag: 'overload_ambiguous' },
            { message: "too many arguments to function 'int f(int)'", expectedTag: 'overload_ambiguous' },
            { message: 'too few arguments to function', expectedTag: 'overload_ambiguous' },
            { message: 'control reaches end of non-void function', expectedTag: 'control_flow_return' },
            { message: 'not all control paths return a value', expectedTag: 'control_flow_return' },
            { message: "base operand of '->' has non-pointer type", expectedTag: 'pointer_dereference_mismatch' },
            { message: "request for member 'x' in 'y', which is of non-class type 'int'", expectedTag: 'pointer_dereference_mismatch' },
            { message: "invalid types 'int[int]' for array subscript", expectedTag: 'pointer_dereference_mismatch' },
            // 既有 pattern 补强的新文案变体:
            { message: "use of undeclared identifier 'x'", expectedTag: 'undeclared_identifier' },
            { message: "invalid conversion from 'int' to 'char'", expectedTag: 'type_conversion' },
            { message: "narrowing conversion of 'x' from 'int' to 'char'", expectedTag: 'type_conversion' },
            { message: 'unresolved external symbol "void __cdecl f(void)"', expectedTag: 'undefined_reference' },
            // P4 新增 MSVC 文案变体(每条新增正则至少一条 stderr 样本):
            // C2065
            { message: "'cout': undeclared identifier", expectedTag: 'undeclared_identifier' },
            // C2143
            { message: "syntax error: missing ';' before '}'", expectedTag: 'missing_semicolon' },
            // C4244
            { message: "'initializing': conversion from 'double' to 'int', possible loss of data", expectedTag: 'type_conversion' },
            // LNK2019 完整形态(P0 已有 unresolved external symbol,此处补全链路形态)
            { message: 'main.obj : error LNK2019: unresolved external symbol "void __cdecl foo(void)" (?foo@@YAXXZ) referenced in function _main', expectedTag: 'undefined_reference' },
            // LNK2001 完整形态
            { message: 'a.obj : error LNK2001: unresolved external symbol "int __cdecl bar(int)" (?bar@@YAHH@Z)', expectedTag: 'undefined_reference' },
            // LNK2005
            { message: '_foo already defined in main.obj', expectedTag: 'multiple_definition' },
            // LNK1104
            { message: "fatal error LNK1104: cannot open file 'kernel32.lib'", expectedTag: 'missing_library' },
            // C1083 完整形态
            { message: "fatal error C1083: Cannot open include file: 'myheader.h': No such file or directory", expectedTag: 'missing_header' },
            // C2668
            { message: "'f': ambiguous call to overloaded function", expectedTag: 'overload_ambiguous' },
            // C2106
            { message: "'=': left operand must be l-value", expectedTag: 'lvalue_required' },
            // C4716
            { message: "'test': must return a value", expectedTag: 'control_flow_return' },
            // C2227
            { message: "left of '->member' must point to class/struct/union/generic type", expectedTag: 'pointer_dereference_mismatch' },
            // member_not_found 新增正则的 stderr 样本:GCC 完整形态(含 did you mean
            // 附加句)/GCC 简短形态/Clang 形态
            { message: "'class std::vector<int>' has no member named 'pushback'; did you mean 'push_back'?", expectedTag: 'member_not_found' },
            { message: "'struct Point' has no member named 'SetX'", expectedTag: 'member_not_found' },
            { message: "no member named 'pushback' in 'std::vector<int>'", expectedTag: 'member_not_found' },
            // member_not_found 补 MSVC C2039 变体(errorParser 放行带码行后端到端可达):
            { message: "'pushback': is not a member of 'std::vector<int>'", expectedTag: 'member_not_found' },
            // operator_operand_mismatch 补 MSVC C2676 变体(官方完整文案,
            // https://learn.microsoft.com/cpp/error-messages/compiler-errors-2/compiler-error-c2676):
            { message: "binary '++': 'std::list<int>' does not define this operator or a conversion to a type acceptable to the predefined operator", expectedTag: 'operator_operand_mismatch' },
            { message: "binary '++': 'std::list<int>' does not define this operator", expectedTag: 'operator_operand_mismatch' },
        ];

        for (const c of cases) {
            const matches = matchErrorToKnowledge(c.message);
            assert.ok(
                matches.some((m) => m.tag === c.expectedTag),
                `expected ${c.expectedTag} for "${c.message}", got ${matches.map((m) => m.tag).join(', ')}`
            );
        }
    });

    it('matches expected tags for real MSVC diagnostic lines end-to-end (parse full line, then match message)', () => {
        // 真实 MSVC 输出在 severity 与冒号之间插诊断码(C2676/LNK2019/…),
        // 此前整行解析不出 ParsedError,知识卡链路拿不到。本用例从整行出发,
        // 断言「extractErrorLocation 放行 → message 剥码 → matchErrorToKnowledge 命中」
        // 全链路;文案依据 Microsoft Learn 各错误文档原文。
        const cases: { line: string; expectedTag: string }[] = [
            { line: "main.cpp(12,5): error C2676: binary '++': 'std::list<int>' does not define this operator", expectedTag: 'operator_operand_mismatch' },
            { line: "main.cpp(3): fatal error C1083: Cannot open include file: 'x.h': No such file or directory", expectedTag: 'missing_header' },
            { line: "main.cpp(8): warning C4244: 'initializing': conversion from 'double' to 'int', possible loss of data", expectedTag: 'type_conversion' },
            { line: "main.cpp(2): error C2039: 'pushback': is not a member of 'std::vector<int>'", expectedTag: 'member_not_found' },
            { line: "main.cpp(6): error C2065: 'cout': undeclared identifier", expectedTag: 'undeclared_identifier' },
            { line: "main.cpp(4): error C2143: syntax error: missing ';' before '}'", expectedTag: 'missing_semicolon' },
            { line: "main.cpp(9): error C2668: 'f': ambiguous call to overloaded function", expectedTag: 'overload_ambiguous' },
            { line: "main.cpp(7): error C2106: '=': left operand must be l-value", expectedTag: 'lvalue_required' },
            { line: "main.cpp(11): warning C4716: 'test': must return a value", expectedTag: 'control_flow_return' },
            { line: "main.cpp(5): error C2227: left of '->member' must point to class/struct/union/generic type", expectedTag: 'pointer_dereference_mismatch' },
            { line: 'main.obj : error LNK2019: unresolved external symbol "void __cdecl foo(void)" (?foo@@YAXXZ) referenced in function _main', expectedTag: 'undefined_reference' },
            { line: 'a.obj : error LNK2005: _foo already defined in main.obj', expectedTag: 'multiple_definition' },
            { line: "LINK : fatal error LNK1104: cannot open file 'kernel32.lib'", expectedTag: 'missing_library' },
        ];

        for (const c of cases) {
            const parsed = extractErrorLocation(c.line);
            assert.ok(parsed, `line should parse: ${c.line}`);
            assert.strictEqual(
                parsed!.severity === 'error' || parsed!.severity === 'warning',
                true,
                `line should carry error/warning severity: ${c.line}`
            );
            const matches = matchErrorToKnowledge(parsed!.message);
            assert.ok(
                matches.some((m) => m.tag === c.expectedTag),
                `expected ${c.expectedTag} for "${c.line}" (parsed message: "${parsed!.message}"), got ${matches.map((m) => m.tag).join(', ')}`
            );
        }
    });
});
