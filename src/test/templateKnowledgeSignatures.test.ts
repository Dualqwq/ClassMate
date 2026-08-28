import * as assert from 'assert';
import { describe, it } from 'mocha';
import { parseCompilerStderrFull } from '../error/templateBacktrace';
import { matchTemplateErrorToKnowledge } from '../error/templateKnowledgeSignatures';
import type { ParsedError } from '../error/errorParser';
import {
    C1_DEFAULT,
    C2_TRANSFORM_MAP,
    C3_SET_PATH,
    C3_SORT_PATH,
    C4_OSTREAM,
    C5_TYPENAME,
    C6_VECTOR_BOOL,
} from './fixtures-template-errors';

function leafOf(fixture: string): ParsedError {
    const leaf = parseCompilerStderrFull(fixture).find((p) => p.severity === 'error');
    assert.ok(leaf, 'expected at least one error-severity diagnostic');
    return leaf;
}

function tagsOf(fixture: string): string[] {
    return matchTemplateErrorToKnowledge(leafOf(fixture)).map((m) => m.tag);
}

describe('template error signature table (P5b)', () => {
    it('maps the sort+list leaf×chain signature to iterator_category_mismatch (case 1)', () => {
        assert.deepStrictEqual(tagsOf(C1_DEFAULT), ['iterator_category_mismatch']);
    });

    it('maps both missing-operator< leaf shapes to comparator_not_defined (case 3)', () => {
        // sort 路径:叶子 no match for call to '(std::less<void>) (Point&, Point&)'。
        assert.deepStrictEqual(tagsOf(C3_SORT_PATH), ['comparator_not_defined']);
        // set 路径:叶子 no match for 'operator<',链签名带 _Compare = std::less<Point>。
        assert.deepStrictEqual(tagsOf(C3_SET_PATH), ['comparator_not_defined']);
    });

    it('maps the transform-over-map lambda signature to map_value_type_const (case 2)', () => {
        assert.deepStrictEqual(tagsOf(C2_TRANSFORM_MAP), ['map_value_type_const']);
    });

    it('maps the ostream leaf to stream_output_operator even without a chain (case 4)', () => {
        assert.deepStrictEqual(tagsOf(C4_OSTREAM), ['stream_output_operator']);
    });

    it('maps the dependent-name leaf to dependent_name_typename (case 5, control sample)', () => {
        assert.deepStrictEqual(tagsOf(C5_TYPENAME), ['dependent_name_typename']);
    });

    it('maps the vector<bool> proxy leaf to vector_bool_proxy (case 6)', () => {
        assert.deepStrictEqual(tagsOf(C6_VECTOR_BOOL), ['vector_bool_proxy']);
    });

    it('does not fire chain-dependent signatures without their chain', () => {
        // 同一句 operator- 叶子,没有 std::sort+_list_iterator 链时不得命中
        // 迭代器档(此时应交给通用表)。
        const leaf: ParsedError = {
            raw: "main.cpp:5:10: error: no match for 'operator-' (operand types are 'int' and 'int')",
            file: 'main.cpp',
            line: 5,
            column: 10,
            severity: 'error',
            message: "no match for 'operator-' (operand types are 'int' and 'int')",
        };
        assert.deepStrictEqual(matchTemplateErrorToKnowledge(leaf), []);
    });

    it('requires std::less in the chain for the operator< leaf shape', () => {
        const noLessChain = [
            "main.cpp: In instantiation of 'void f(T) [with T = Point]':",
            'main.cpp:4:10:   required from here',
            "point.h:3:9: error: no match for 'operator<' (operand types are 'Point' and 'Point')",
        ].join('\n');
        const leaf = leafOf(noLessChain);
        assert.deepStrictEqual(matchTemplateErrorToKnowledge(leaf), []);
    });

    it('stays silent on generic non-template diagnostics', () => {
        const leaf: ParsedError = {
            raw: "main.cpp:3:5: error: no match for call to 'foo'",
            file: 'main.cpp',
            line: 3,
            column: 5,
            severity: 'error',
            message: "no match for call to 'foo'",
        };
        assert.deepStrictEqual(matchTemplateErrorToKnowledge(leaf), []);
    });
});
