import * as assert from 'assert';
import { describe, it } from 'mocha';
import { buildConceptProfile, type ConceptProfile } from '../debug/conceptProfiling';
import { buildErrorLifecycles } from '../debug/errorLifecycle';
import type { CompileErrorEvent, CompileSuccessEvent, DebugEvent } from '../debug/types';

function compileError(id: string, timestamp: number, messages: string[]): CompileErrorEvent {
    return {
        id,
        type: 'compile_error',
        timestamp,
        sessionId: 'session-1',
        workspaceId: 'ws',
        fileUri: 'file:///main.cpp',
        stderr: messages.join('\n'),
        parsedErrors: messages.map((message) => ({
            raw: message,
            severity: 'error' as const,
            message,
        })),
        exitCode: 1,
        durationMs: 100,
    };
}

function compileSuccess(id: string, timestamp: number): CompileSuccessEvent {
    return {
        id,
        type: 'compile_success',
        timestamp,
        sessionId: 'session-1',
        workspaceId: 'ws',
        fileUri: 'file:///main.cpp',
        exitCode: 0,
        durationMs: 100,
    };
}

function findTag(profiles: ConceptProfile[], tag: string): ConceptProfile | undefined {
    return profiles.find((p) => p.tag === tag);
}

describe('Concept Profiling', () => {
    /**
     * 构造一个覆盖多种知识点的事件流，并给出每个概念的预期指标。
     * 使用 lookAheadCompiles=1，语义清晰：只看紧接着的下一次编译。
     *
     * 事件流（同一文件，同一 session）：
     *   t=1  function_call_mismatch: no matching function for call to 'foo'
     *   t=2  type_conversion:       cannot convert 'std::string' to 'int'
     *   t=3  undefined_reference:   undefined reference to 'bar'
     *   t=4  multiple_definition:   multiple definition of 'baz'
     *   t=5  segmentation_fault:    segmentation fault
     *   t=6  [undeclared_identifier: 'a' was not declared in this scope,
     *        missing_semicolon:     expected ';' before 'return']
     *   t=7  [undeclared 'b', missing_semicolon]
     *   t=8  [undeclared 'c', missing_semicolon]
     *   t=9  [undeclared 'd', missing_semicolon]
     *   t=10 undeclared 'e'          （不再包含 missing_semicolon）
     *   t=11 undeclared 'f'          （不再包含 missing_semicolon）
     *
     * 生命周期判定（lookAheadCompiles=1）：
     *   - function_call_mismatch: e1 的下一次 e2 不出现 → resolved@t=2, attempts=1
     *   - type_conversion:        e2 的下一次 e3 不出现 → resolved@t=3, attempts=1
     *   - undefined_reference:    e3 的下一次 e4 不出现 → resolved@t=4, attempts=1
     *   - multiple_definition:    e4 的下一次 e5 不出现 → resolved@t=5, attempts=1
     *   - segmentation_fault:     e5 的下一次 e6 不出现 → resolved@t=6, attempts=1
     *   - undeclared_identifier:  e6-e10 的下一次仍出现；e11 之后无编译 → 全部 unresolved
     *                             attempts 分别为 1,1,1,1,1,0
     *   - missing_semicolon:      e6-e8 的下一次仍出现；e9 的下一次 e10 没有 → resolved@t=10
     *                             attempts 分别为 1,1,1,1
     *
     * 知识点画像预期：
     *   按 未解决数 > 出现次数 > 平均修复尝试 > 最后出现时间 降序排列。
     *
     *   1. undeclared_identifier: unresolved=6, occurrence=6, avgFixAttempts=5/6, lastSeen=11
     *   2-3. missing_semicolon / syntax_punctuation 并列：
     *        unresolved=3, occurrence=4, avgFixAttempts=1, lastSeen=9
     *   4-8. 其余已解决概念（顺序由 lastSeenAt 降序决定）：
     *        segmentation_fault(5), multiple_definition(4), undefined_reference(3), type_conversion(2), function_call_mismatch(1)
     */
    it('covers multiple concepts, ranks unresolved first, and computes metrics', () => {
        const events: DebugEvent[] = [
            compileError('e1', 1, ["no matching function for call to 'foo'"]),
            compileError('e2', 2, ["cannot convert 'std::string' to 'int'"]),
            compileError('e3', 3, ["undefined reference to 'bar'"]),
            compileError('e4', 4, ["multiple definition of 'baz'"]),
            compileError('e5', 5, ["segmentation fault"]),
            compileError('e6', 6, [
                "'a' was not declared in this scope",
                "expected ';' before 'return'",
            ]),
            compileError('e7', 7, [
                "'b' was not declared in this scope",
                "expected ';' before 'return'",
            ]),
            compileError('e8', 8, [
                "'c' was not declared in this scope",
                "expected ';' before 'return'",
            ]),
            compileError('e9', 9, [
                "'d' was not declared in this scope",
                "expected ';' before 'return'",
            ]),
            compileError('e10', 10, ["'e' was not declared in this scope"]),
            compileError('e11', 11, ["'f' was not declared in this scope"]),
        ];

        const lifecycles = buildErrorLifecycles(events, { lookAheadCompiles: 1 });
        const profiles = buildConceptProfile(events, lifecycles);

        // 8 个知识点画像：7 个显式概念 + syntax_punctuation。
        assert.strictEqual(profiles.length, 8);

        // 第一名：undeclared_identifier，全部未解决。
        assert.strictEqual(profiles[0].tag, 'undeclared_identifier');
        assert.strictEqual(profiles[0].unresolvedCount, 6);
        assert.strictEqual(profiles[0].resolvedCount, 0);
        assert.strictEqual(profiles[0].occurrenceCount, 6);
        assert.strictEqual(profiles[0].avgFixAttempts, 5 / 6);
        assert.strictEqual(profiles[0].lastSeenAt, 11);

        // missing_semicolon 与 syntax_punctuation 因同一消息同时命中，指标相同。
        // 它们都应有 3 个未解决、1 个已解决，排在 undeclared 之后。
        const missingSemicolon = findTag(profiles, 'missing_semicolon');
        const syntaxPunctuation = findTag(profiles, 'syntax_punctuation');
        assert.ok(missingSemicolon);
        assert.ok(syntaxPunctuation);
        for (const p of [missingSemicolon!, syntaxPunctuation!]) {
            assert.strictEqual(p.unresolvedCount, 3);
            assert.strictEqual(p.resolvedCount, 1);
            assert.strictEqual(p.occurrenceCount, 4);
            assert.strictEqual(p.avgFixAttempts, 1);
            assert.strictEqual(p.lastSeenAt, 9);
        }

        // 未解决画像共 3 个：undeclared + missing_semicolon + syntax_punctuation。
        const unresolvedProfiles = profiles.filter((p) => p.unresolvedCount > 0);
        assert.strictEqual(unresolvedProfiles.length, 3);

        // 所有未解决画像都排在已解决画像之前。
        const firstResolvedIndex = profiles.findIndex((p) => p.unresolvedCount === 0);
        assert.strictEqual(firstResolvedIndex, 3);
        for (const profile of profiles.slice(0, firstResolvedIndex)) {
            assert.ok(profile.unresolvedCount > 0);
        }
        for (const profile of profiles.slice(firstResolvedIndex)) {
            assert.strictEqual(profile.unresolvedCount, 0);
        }

        // 其余已解决概念逐个校验。
        const segmentationFault = findTag(profiles, 'segmentation_fault');
        assert.ok(segmentationFault);
        assert.strictEqual(segmentationFault!.unresolvedCount, 0);
        assert.strictEqual(segmentationFault!.resolvedCount, 1);
        assert.strictEqual(segmentationFault!.occurrenceCount, 1);
        assert.strictEqual(segmentationFault!.avgFixAttempts, 1);
        assert.strictEqual(segmentationFault!.lastSeenAt, 5);

        const multipleDefinition = findTag(profiles, 'multiple_definition');
        assert.ok(multipleDefinition);
        assert.strictEqual(multipleDefinition!.unresolvedCount, 0);
        assert.strictEqual(multipleDefinition!.resolvedCount, 1);
        assert.strictEqual(multipleDefinition!.occurrenceCount, 1);
        assert.strictEqual(multipleDefinition!.avgFixAttempts, 1);
        assert.strictEqual(multipleDefinition!.lastSeenAt, 4);

        const undefinedRef = findTag(profiles, 'undefined_reference');
        assert.ok(undefinedRef);
        assert.strictEqual(undefinedRef!.unresolvedCount, 0);
        assert.strictEqual(undefinedRef!.resolvedCount, 1);
        assert.strictEqual(undefinedRef!.occurrenceCount, 1);
        assert.strictEqual(undefinedRef!.avgFixAttempts, 1);
        assert.strictEqual(undefinedRef!.lastSeenAt, 3);

        const typeConversion = findTag(profiles, 'type_conversion');
        assert.ok(typeConversion);
        assert.strictEqual(typeConversion!.unresolvedCount, 0);
        assert.strictEqual(typeConversion!.resolvedCount, 1);
        assert.strictEqual(typeConversion!.occurrenceCount, 1);
        assert.strictEqual(typeConversion!.avgFixAttempts, 1);
        assert.strictEqual(typeConversion!.lastSeenAt, 2);

        const functionCall = findTag(profiles, 'function_call_mismatch');
        assert.ok(functionCall);
        assert.strictEqual(functionCall!.unresolvedCount, 0);
        assert.strictEqual(functionCall!.resolvedCount, 1);
        assert.strictEqual(functionCall!.occurrenceCount, 1);
        assert.strictEqual(functionCall!.avgFixAttempts, 1);
        assert.strictEqual(functionCall!.lastSeenAt, 1);
    });

    it('returns empty profiles when there are no compile errors', () => {
        const events: DebugEvent[] = [compileSuccess('s1', 1)];
        const lifecycles = buildErrorLifecycles(events);
        const profiles = buildConceptProfile(events, lifecycles);
        assert.strictEqual(profiles.length, 0);
    });
});
