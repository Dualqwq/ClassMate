import * as assert from 'assert';
import { describe, it } from 'mocha';
import { RUN_ERROR_KINDS } from '../run/runErrorKind';
import {
    formatRunErrorPhenomenon,
    getRunErrorKnowledgeConcept,
    listRunErrorKnowledgeConcepts,
} from '../run/runErrorKnowledgeMap';

describe('runErrorKnowledgeMap', () => {
    it('九档 RunErrorKind 都有完整且非空的教学元数据', () => {
        const concepts = listRunErrorKnowledgeConcepts();
        assert.deepStrictEqual(
            concepts.map((concept) => concept.kind),
            RUN_ERROR_KINDS
        );

        for (const concept of concepts) {
            assert.strictEqual(concept.tag, concept.kind);
            assert.ok(concept.title.trim().length > 0, `${concept.kind} title empty`);
            assert.ok(concept.summary.trim().length > 0, `${concept.kind} summary empty`);
            assert.ok(concept.commonCauses.length > 0, `${concept.kind} commonCauses empty`);
            assert.ok(concept.commonCauses.every((item) => item.trim().length > 0));
            assert.ok(concept.suggestedFixes.length > 0, `${concept.kind} suggestedFixes empty`);
            assert.ok(concept.suggestedFixes.every((item) => item.trim().length > 0));
            assert.ok(concept.checkMethod.trim().length > 0, `${concept.kind} checkMethod empty`);
            assert.ok(concept.wrongExample.trim().length > 0, `${concept.kind} wrongExample empty`);
            assert.ok(concept.correctExample.trim().length > 0, `${concept.kind} correctExample empty`);
            assert.strictEqual(getRunErrorKnowledgeConcept(concept.kind), concept);
        }
    });

    it('unknown 只陈述证据不足，现象只拼接事件已有的退出码与 errorDetail', () => {
        const unknown = getRunErrorKnowledgeConcept('runtime_unknown');
        assert.deepStrictEqual(unknown.commonCauses, [
            '现有证据不足，不能诚实地把问题归到某一种具体原因',
        ]);
        assert.ok(!unknown.summary.includes('可能是'));
        assert.ok(!unknown.commonCauses.join('\n').includes('空指针'));

        assert.strictEqual(
            formatRunErrorPhenomenon(
                'runtime_unknown',
                134,
                '程序抛出了一个未被处理的异常（类型：MyError）'
            ),
            '运行出错：原因不明(退出码 134)；程序抛出了一个未被处理的异常（类型：MyError）'
        );
        assert.strictEqual(
            formatRunErrorPhenomenon('runtime_time_limit_exceeded', null),
            '运行出错：超出时限(可能是死循环)(退出码 未知)'
        );
    });
});
