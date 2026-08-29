import * as assert from 'assert';
import { describe, it } from 'mocha';
import {
    attachSelectionTemplateContext,
    collectTemplateChains,
    describeTemplateChain,
    isSystemTemplateFrameFile,
    parseCompilerStderrFull,
    resolveAttributedError,
} from '../error/templateBacktrace';
import { extractErrorLocation } from '../error/errorParser';
import type { ParsedError } from '../error/errorParser';
import { getKnowledgeConcept } from '../error/errorKnowledgeMap';
import { generateKnowledgeCard, pickRepresentativeError } from '../debug/knowledgeCard';
import { buildErrorLifecycles } from '../debug/errorLifecycle';
import type { CompileErrorEvent, DebugEvent } from '../debug/types';
import {
    C1_DEFAULT,
    C1_OLDLOOK,
    C2_TRANSFORM_MAP,
    C3_SET_PATH,
    C3_SORT_PATH,
    C4_OSTREAM,
    C5_TYPENAME,
    C6_VECTOR_BOOL,
} from './fixtures-template-errors';

function firstError(parsed: ParsedError[]): ParsedError {
    const leaf = parsed.find((p) => p.severity === 'error');
    assert.ok(leaf, 'expected at least one error-severity diagnostic');
    return leaf;
}

function makeCompileErrorEvent(stderr: string, parsedErrors: ParsedError[]): CompileErrorEvent {
    return {
        id: 'e1',
        type: 'compile_error',
        timestamp: 0,
        sessionId: 's1',
        workspaceId: 'ws',
        fileUri: 'file:///main.cpp',
        stderr,
        parsedErrors,
        exitCode: 1,
        durationMs: 1,
    };
}

describe('template backtrace chain parsing (P5a)', () => {
    it('attaches the instantiation chain to the STL leaf and attributes the student line (c1 hierarchical look)', () => {
        const parsed = parseCompilerStderrFull(C1_DEFAULT);
        const leaf = firstError(parsed);
        assert.strictEqual(
            leaf.file,
            'D:/mingw64/include/c++/16.1.0/bits/stl_algo.h',
            'leaf keeps its own (STL) location'
        );
        assert.strictEqual(leaf.line, 1914);

        const chain = leaf.templateChain;
        assert.ok(chain, 'chained leaf must carry templateChain');
        assert.strictEqual(chain!.frames.length, 3);

        const [inst, required, here] = chain!.frames;
        assert.strictEqual(inst.kind, 'instantiation');
        assert.strictEqual(inst.file, 'D:/mingw64/include/c++/16.1.0/bits/stl_algo.h');
        assert.strictEqual(inst.line, undefined);
        assert.strictEqual(inst.isSystem, true);
        assert.ok(inst.signature?.includes('_List_iterator<int>'));

        assert.strictEqual(required.kind, 'required');
        assert.strictEqual(required.file, 'D:/mingw64/include/c++/16.1.0/bits/stl_algo.h');
        assert.strictEqual(required.line, 4817);
        assert.strictEqual(required.column, 18);
        assert.strictEqual(required.isSystem, true);
        assert.ok(required.signature?.includes('std::sort'));

        assert.strictEqual(here.kind, 'here');
        assert.strictEqual(here.file, 'c1_sort_list.cpp');
        assert.strictEqual(here.line, 7);
        assert.strictEqual(here.column, 14);
        assert.strictEqual(here.isSystem, false);
        assert.strictEqual(here.signature, undefined);

        assert.strictEqual(chain!.attributed, chain!.frames[2]);

        // 叶子既能有 include 栈也能有模板链:两者共存互不覆盖。
        assert.deepStrictEqual(leaf.viaIncludes, [
            'D:/mingw64/include/c++/16.1.0/algorithm:63',
            'c1_sort_list.cpp:2',
        ]);

        // 新观感的缩进候选子弹(`• candidate 1: ...` 等)不得拼出幽灵链。
        assert.strictEqual(collectTemplateChains(C1_DEFAULT).length, 1);
    });

    it('parses the identical chain shape in the old flat look (c1 -fno-diagnostics-show-nesting)', () => {
        const hits = collectTemplateChains(C1_OLDLOOK);
        assert.strictEqual(hits.length, 1);
        assert.strictEqual(hits[0].chain.frames.length, 3);
        assert.strictEqual(hits[0].chain.attributed?.file, 'c1_sort_list.cpp');
        assert.strictEqual(hits[0].chain.attributed?.line, 7);

        // 旧观感的候选/note 行顶格但都是 note severity:不得消费或延长链。
        const leaf = firstError(parseCompilerStderrFull(C1_OLDLOOK));
        assert.strictEqual(leaf.templateChain?.frames.length, 3);
    });

    it('keeps the chain across source-excerpt lines and long signatures (c3 sort path, 5 frames)', () => {
        const hits = collectTemplateChains(C3_SORT_PATH);
        assert.strictEqual(hits.length, 1);
        assert.deepStrictEqual(
            hits[0].chain.frames.map((f) => f.kind),
            ['instantiation', 'required', 'required', 'required', 'here']
        );
        assert.strictEqual(hits[0].chain.attributed?.file, 'c3_set_missing_lt.cpp');
        assert.strictEqual(hits[0].chain.attributed?.line, 17);
        assert.strictEqual(hits[0].chain.attributed?.column, 14);

        const leaf = firstError(parseCompilerStderrFull(C3_SORT_PATH));
        assert.strictEqual(leaf.file, 'D:/mingw64/include/c++/16.1.0/bits/stl_algo.h');
        assert.strictEqual(leaf.line, 1781);
        assert.ok(leaf.message.includes('std::less<void>'));
    });

    it('parses each error in a multi-error output against its own chain (c3 set path)', () => {
        const hits = collectTemplateChains(C3_SET_PATH);
        assert.strictEqual(hits.length, 1);
        assert.strictEqual(hits[0].chain.frames.length, 6);
        assert.strictEqual(hits[0].chain.attributed?.file, 'c3_set_missing_lt.cpp');
        assert.strictEqual(hits[0].chain.attributed?.line, 14);
        assert.strictEqual(hits[0].chain.attributed?.column, 13);

        const leaf = firstError(parseCompilerStderrFull(C3_SET_PATH));
        assert.strictEqual(leaf.file, 'D:/mingw64/include/c++/16.1.0/bits/stl_function.h');
        assert.strictEqual(leaf.line, 408);
        assert.ok(leaf.message.includes("no match for 'operator<'"));

        // 两个错误拼在一起时,各自命中各自的链,归因互不串扰。
        const combined = collectTemplateChains(`${C3_SORT_PATH}\n${C3_SET_PATH}`);
        assert.strictEqual(combined.length, 2);
        assert.strictEqual(combined[0].chain.attributed?.line, 17);
        assert.strictEqual(combined[1].chain.attributed?.line, 14);
    });

    it('does not treat indented continuation lines as chain frames (c2)', () => {
        const hits = collectTemplateChains(C2_TRANSFORM_MAP);
        assert.strictEqual(hits.length, 1);
        // 只有 instantiation + here 两帧;候选区里缩进的 c2_transform_map.cpp:13:21/:20
        // 是定位提示行,不是链帧。
        assert.strictEqual(hits[0].chain.frames.length, 2);
        assert.strictEqual(hits[0].chain.attributed?.file, 'c2_transform_map.cpp');
        assert.strictEqual(hits[0].chain.attributed?.line, 12);
        assert.strictEqual(hits[0].chain.attributed?.column, 19);
        assert.ok(
            !hits[0].chain.frames.some((f) => f.line === 13 || f.line === 21 || f.line === 20),
            'candidate location lines must not become frames'
        );

        const leaf = firstError(parseCompilerStderrFull(C2_TRANSFORM_MAP));
        assert.strictEqual(leaf.line, 4240);
        assert.ok(leaf.message.includes('pair<const'));
    });

    it('matches leaf-only errors without inventing chains (c4/c5/c6)', () => {
        for (const [fixture, file, line] of [
            [C4_OSTREAM, 'c4_ostream_custom.cpp', 12],
            [C5_TYPENAME, 'c5_missing_typename.cpp', 6],
            [C6_VECTOR_BOOL, 'c6_vectorbool_binding.cpp', 6],
        ] as const) {
            assert.strictEqual(collectTemplateChains(fixture).length, 0, fixture.slice(0, 40));
            const parsed = parseCompilerStderrFull(fixture);
            const leaf = firstError(parsed);
            assert.strictEqual(leaf.templateChain, undefined, file);
            assert.strictEqual(leaf.file, file);
            assert.strictEqual(leaf.line, line);
        }
        const c6Leaf = firstError(parseCompilerStderrFull(C6_VECTOR_BOOL));
        assert.strictEqual(c6Leaf.column, 20);
    });

    it('rejects chain frames more than 25 lines away from their leaf (gap guard)', () => {
        const opener = "D:/mingw64/include/c++/16.1.0/bits/stl_algo.h: In instantiation of 'void f(T) [with T = int]':";
        const leaf = "main.cpp:5:10: error: no match for 'operator-' (operand types are 'int' and 'int')";
        const far = [opener, ...Array.from({ length: 26 }, () => ''), leaf].join('\n');
        assert.strictEqual(collectTemplateChains(far).length, 0);

        const near = [opener, '', '', '', '', leaf].join('\n');
        assert.strictEqual(collectTemplateChains(near).length, 1);
    });

    it('ignores orphan required frames without an instantiation opener', () => {
        const orphan = [
            'main.cpp:4:10:   required from here',
            "main.cpp:5:10: error: no match for 'operator-'",
        ].join('\n');
        assert.strictEqual(collectTemplateChains(orphan).length, 0);
    });

    it('rejects indented bullet chain lines in a constructed hierarchical candidate block', () => {
        const sample = [
            "D:/mingw64/include/c++/16.1.0/bits/stl_algo.h: In instantiation of 'void std::__sort(_RAIter, _RAIter) [with _RAIter = _List_iterator<int>]':",
            '    • required from here',
            "main.cpp:7:14: error: no match for 'operator-' (operand types are 'std::_List_iterator<int>' and 'std::_List_iterator<int>')",
        ].join('\n');
        const hits = collectTemplateChains(sample);
        assert.strictEqual(hits.length, 1);
        // 缩进的 `• required from here` 不得成为帧:链上只剩系统 instantiation 帧,
        // 没有学生归因(比把学生行错归到幽灵帧更保守)。
        assert.strictEqual(hits[0].chain.frames.length, 1);
        assert.strictEqual(hits[0].chain.frames[0].isSystem, true);
        assert.strictEqual(hits[0].chain.attributed, undefined);
    });

    it('classifies absolute-path frames via workspaceRoot when given', () => {
        const sample = [
            "C:/users/student/hw/main.cpp: In instantiation of 'void f(T) [with T = int]':",
            'C:/users/student/hw/main.cpp:4:10:   required from here',
            "D:/mingw64/include/c++/16.1.0/bits/stl_algo.h:1914:50: error: no match for 'operator-'",
        ].join('\n');

        const withRoot = collectTemplateChains(sample, { workspaceRoot: 'C:/users/student/hw' });
        assert.strictEqual(withRoot.length, 1);
        assert.strictEqual(withRoot[0].chain.attributed?.file, 'C:/users/student/hw/main.cpp');
        assert.strictEqual(withRoot[0].chain.attributed?.line, 4);

        // 缺省时绝对路径一律按系统帧:宁可不归因,不误归因。
        const withoutRoot = collectTemplateChains(sample);
        assert.strictEqual(withoutRoot.length, 1);
        assert.strictEqual(withoutRoot[0].chain.attributed, undefined);

        assert.strictEqual(isSystemTemplateFrameFile('main.cpp'), false);
        assert.strictEqual(isSystemTemplateFrameFile(undefined), false);
        assert.strictEqual(
            isSystemTemplateFrameFile('D:/mingw64/include/c++/16.1.0/bits/stl_algo.h'),
            true
        );
        assert.strictEqual(
            isSystemTemplateFrameFile('C:/users/student/hw/main.cpp', 'C:/users/student/hw'),
            false
        );
        assert.strictEqual(
            isSystemTemplateFrameFile('C:/other/project/main.cpp', 'C:/users/student/hw'),
            true
        );
    });

    it('parses Clang "in instantiation of ... requested here" notes (constructed, untested on real clang)', () => {
        const sample = [
            "main.cpp:7:5: note: in instantiation of function template specialization 'std::sort<std::_List_iterator<int>, std::less<int> >' requested here",
            "/usr/include/c++/11/bits/stl_algo.h:1914:50: error: no match for 'operator-' (operand types are 'std::_List_iterator<int>' and 'std::_List_iterator<int>')",
        ].join('\n');
        const hits = collectTemplateChains(sample);
        assert.strictEqual(hits.length, 1);
        assert.strictEqual(hits[0].chain.frames.length, 1);
        assert.strictEqual(hits[0].chain.frames[0].kind, 'instantiation');
        assert.ok(hits[0].chain.frames[0].signature?.includes('std::sort'));
        assert.strictEqual(hits[0].chain.attributed?.file, 'main.cpp');
        assert.strictEqual(hits[0].chain.attributed?.line, 7);
    });

    it('parses MSVC see-reference notes (constructed, untested on real MSVC)', () => {
        // bare-severity 形态(无诊断码)验证链帧句式本身;真实带码形态
        // (`error C2676:`)见下一个用例。
        const sample = [
            "main.cpp(9): note: see reference to function template instantiation 'void std::sort<std::_List_iterator<int>>(const _RanIt,const _RanIt)' being compiled",
            "main.cpp(12,5): error: binary '-': 'std::_List_iterator<int>' does not define this operator",
        ].join('\n');
        const hits = collectTemplateChains(sample);
        assert.strictEqual(hits.length, 1);
        assert.strictEqual(hits[0].chain.frames.length, 1);
        assert.strictEqual(hits[0].chain.frames[0].kind, 'instantiation');
        assert.strictEqual(hits[0].chain.frames[0].line, 9);
        assert.strictEqual(hits[0].chain.attributed?.file, 'main.cpp');
    });

    it('attaches MSVC chain when the leaf uses the real `error Cxxxx:` coded form (constructed, untested on real MSVC)', () => {
        // 真实 MSVC 叶子行带诊断码(`error C2676:`),此前 extractErrorLocation
        // 不解析、链扫不到叶子;errorParser 放行带码行后该形态应同样成链。
        const sample = [
            "main.cpp(9): note: see reference to function template instantiation 'void std::sort<std::_List_iterator<int>>(const _RanIt,const _RanIt)' being compiled",
            "main.cpp(12,5): error C2676: binary '-': 'std::_List_iterator<int>' does not define this operator or a conversion to a type acceptable to the predefined operator",
        ].join('\n');
        const hits = collectTemplateChains(sample);
        assert.strictEqual(hits.length, 1);
        assert.strictEqual(hits[0].chain.frames.length, 1);
        assert.strictEqual(hits[0].chain.frames[0].kind, 'instantiation');
        assert.strictEqual(hits[0].chain.frames[0].line, 9);
        assert.strictEqual(hits[0].chain.attributed?.file, 'main.cpp');
        assert.strictEqual(hits[0].chain.attributed?.line, 9);
        assert.ok(hits[0].leafRaw.includes('error C2676:'));
    });
});

describe('template attribution helpers (P5a)', () => {
    it('resolveAttributedError relocates the chained leaf to the student line', () => {
        const leaf = firstError(parseCompilerStderrFull(C1_DEFAULT));
        const attributed = resolveAttributedError(leaf);
        assert.notStrictEqual(attributed, leaf, 'chained leaf must be copied');
        assert.strictEqual(attributed.file, 'c1_sort_list.cpp');
        assert.strictEqual(attributed.line, 7);
        assert.strictEqual(attributed.column, 14);
        assert.strictEqual(attributed.message, leaf.message);
        assert.strictEqual(attributed.raw, leaf.raw);
        // viaIncludes 描述的是"怎么 include 进 STL 的",对归因位置是噪音。
        assert.strictEqual(attributed.viaIncludes, undefined);
    });

    it('resolveAttributedError returns the same object for unchained errors', () => {
        const parsed = extractErrorLocation("main.cpp:3:5: error: expected ';' before '}' token");
        assert.ok(parsed);
        assert.strictEqual(resolveAttributedError(parsed), parsed);
    });

    it('describeTemplateChain renders the root-cause line for a chained leaf', () => {
        const leaf = firstError(parseCompilerStderrFull(C1_DEFAULT));
        assert.strictEqual(
            describeTemplateChain(leaf),
            'Root-cause frame: c1_sort_list.cpp:7:14 (required from here); error leaf: D:/mingw64/include/c++/16.1.0/bits/stl_algo.h:1914'
        );
    });

    it('describeTemplateChain falls back for chains that stay inside library headers', () => {
        const systemOnly = [
            "D:/mingw64/include/c++/16.1.0/bits/stl_algo.h: In instantiation of 'void f(T) [with T = int]':",
            'D:/mingw64/include/c++/16.1.0/bits/stl_algo.h:4817:18:   required from here',
            "D:/mingw64/include/c++/16.1.0/bits/stl_algo.h:1914:50: error: no match for 'operator-'",
        ].join('\n');
        const leaf = firstError(parseCompilerStderrFull(systemOnly));
        assert.ok(leaf.templateChain);
        assert.strictEqual(leaf.templateChain!.attributed, undefined);
        assert.ok(
            describeTemplateChain(leaf)!.startsWith(
                'Template instantiation chain stays inside library headers'
            )
        );
        assert.strictEqual(resolveAttributedError(leaf), leaf);
    });

    it('attachSelectionTemplateContext finds the chain from the full compile output', () => {
        const leafLine =
            "D:/mingw64/include/c++/16.1.0/bits/stl_algo.h:1914:50: error: no match for 'operator-' (operand types are 'std::_List_iterator<int>' and 'std::_List_iterator<int>')";
        const parsed = extractErrorLocation(leafLine);
        assert.ok(parsed);
        const summary = attachSelectionTemplateContext(parsed, C1_DEFAULT);
        assert.strictEqual(
            summary,
            'Root-cause frame: c1_sort_list.cpp:7:14 (required from here); error leaf: D:/mingw64/include/c++/16.1.0/bits/stl_algo.h:1914'
        );
        assert.strictEqual(parsed.templateChain?.attributed?.file, 'c1_sort_list.cpp');

        const plain = extractErrorLocation("main.cpp:3:5: error: expected ';' before '}' token");
        assert.ok(plain);
        assert.strictEqual(attachSelectionTemplateContext(plain, C1_DEFAULT), undefined);
        assert.strictEqual(plain.templateChain, undefined);
    });
});

describe('template backtrace → knowledge cards (P5b integration)', () => {
    it('routes a chained STL leaf to the template card and reports the student line', () => {
        const parsedErrors = parseCompilerStderrFull(C1_DEFAULT);
        const event = makeCompileErrorEvent(C1_DEFAULT, parsedErrors);
        const events: DebugEvent[] = [event];
        const lifecycles = buildErrorLifecycles(events);
        const cards = generateKnowledgeCard(event, events, lifecycles);

        assert.strictEqual(cards.length, 1);
        assert.strictEqual(
            cards[0].tag,
            'iterator_category_mismatch',
            'template signature must win over the generic operator_operand_mismatch card'
        );
        assert.notStrictEqual(cards[0].tag, 'operator_operand_mismatch');
        assert.strictEqual(cards[0].title, '迭代器类别不满足算法要求');

        const rep = pickRepresentativeError(cards[0], events);
        assert.ok(rep);
        assert.strictEqual(rep.file, 'c1_sort_list.cpp', 'card must point at the student line');
        assert.strictEqual(rep.line, 7);
        assert.strictEqual(rep.column, 14);
    });

    it('routes a leaf-only template error to its template card without moving the location', () => {
        const parsedErrors = parseCompilerStderrFull(C4_OSTREAM);
        const event = makeCompileErrorEvent(C4_OSTREAM, parsedErrors);
        const events: DebugEvent[] = [event];
        const lifecycles = buildErrorLifecycles(events);
        const cards = generateKnowledgeCard(event, events, lifecycles);

        assert.strictEqual(cards.length, 1);
        assert.strictEqual(cards[0].tag, 'stream_output_operator');

        const rep = pickRepresentativeError(cards[0], events);
        assert.ok(rep);
        assert.strictEqual(rep.file, 'c4_ostream_custom.cpp');
        assert.strictEqual(rep.line, 12);
        assert.strictEqual(rep.column, 9);
    });

    it('resolves concept entries for every template signature tag', () => {
        for (const tag of [
            'iterator_category_mismatch',
            'comparator_not_defined',
            'map_value_type_const',
            'stream_output_operator',
            'dependent_name_typename',
            'vector_bool_proxy',
        ]) {
            assert.ok(getKnowledgeConcept(tag), `${tag} concept missing`);
        }
    });
});
