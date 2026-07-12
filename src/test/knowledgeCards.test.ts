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
        assert.strictEqual(concepts.length, 12);
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
        ];

        for (const c of cases) {
            const matches = matchErrorToKnowledge(c.message);
            assert.ok(
                matches.some((m) => m.tag === c.expectedTag),
                `expected ${c.expectedTag} for "${c.message}", got ${matches.map((m) => m.tag).join(', ')}`
            );
        }
    });
});
