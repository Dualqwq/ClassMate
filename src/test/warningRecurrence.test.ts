import * as assert from 'assert';
import { describe, it } from 'mocha';
import { buildJourneyViewModel } from '../journey/journeyViewModel';
import { parseCompilerStderrFull } from '../error/templateBacktrace';
import type { CompileSuccessEvent } from '../debug/types';

function observation(id: number, warnings = ["main.cpp:3:2: warning: possible loss of data [-Wconversion]"], fileUri = 'C:/ws/main.cpp'): CompileSuccessEvent {
    const stderr = warnings.join('\n');
    return { id: `obs-${id}`, type: 'compile_success', timestamp: id * 10000,
        sessionId: 's', workspaceId: 'w', fileUri, stderr,
        parsedErrors: parseCompilerStderrFull(stderr), diagnosticsComplete: true,
        exitCode: 0, durationMs: 1 };
}

describe('Continuous warning journeys', () => {
    it('shows one ongoing warning with every compilation attempt kept once', () => {
        const view = buildJourneyViewModel([observation(1), observation(2), observation(3)]);
        assert.strictEqual(view.episodes.length, 1);
        assert.strictEqual(view.episodes[0].resolved, false);
        assert.strictEqual(view.episodes[0].entries.length, 3);
    });
    it('updates the entire continuous journey when warning disappears beyond five compiles', () => {
        const events = Array.from({ length: 8 }, (_, i) => observation(i + 1));
        const view = buildJourneyViewModel([...events, observation(9, [])]);
        assert.strictEqual(view.episodes.length, 1);
        assert.strictEqual(view.episodes[0].resolvedAt, 90000);
    });
    it('keeps a genuinely fixed then recurring warning as two journeys', () => {
        const view = buildJourneyViewModel([observation(1), observation(2), observation(3, []), observation(4), observation(5)]);
        assert.strictEqual(view.episodes.length, 2);
        assert.strictEqual(view.episodes.filter(e => e.resolved).length, 1);
        assert.strictEqual(view.episodes.filter(e => !e.resolved).length, 1);
    });
});

import { buildErrorLifecycles } from '../debug/errorLifecycle';
import { generateKnowledgeCard, mergeKnowledgeCards } from '../debug/knowledgeCard';
import { buildConceptProfile } from '../debug/conceptProfiling';
import { hasCompileDiagnostics, type DebugEvent } from '../debug/types';

const known = (file = 'main.cpp', line = 3, code = '-Wreturn-type') => `${file}:${line}:2: warning: control reaches end of non-void function [${code}]`;

describe('Warning recurrence boundaries', () => {
    it('keeps moved locations and changed option parameters in one continuous journey', () => {
        const view = buildJourneyViewModel([observation(1, [known('main.cpp', 3, '-Wfoo=1')]), observation(2, [known('main.cpp', 9, '-Wfoo=2')])]);
        assert.strictEqual(view.episodes.length, 1);
        assert.strictEqual(view.episodes[0].warningLocations?.[0].line, 9);
    });
    it('counts two sites and repeated builds as one lifecycle, card and concept occurrence', () => {
        const events = [observation(1, [known(), known('main.cpp', 8)]), observation(2, [known(), known('main.cpp', 8)])];
        const lifecycles = buildErrorLifecycles(events);
        const cards = mergeKnowledgeCards(events.flatMap(e => hasCompileDiagnostics(e) ? generateKnowledgeCard(e, events, lifecycles) : []));
        assert.strictEqual(lifecycles.length, 1);
        assert.strictEqual(buildJourneyViewModel(events).episodes[0].warningLocations?.length, 2);
        assert.strictEqual(cards.length, 1);
        assert.strictEqual(cards[0].frequency, 1);
        assert.deepStrictEqual(cards[0].sourceEvents, ['obs-1', 'obs-2']);
        assert.strictEqual(buildConceptProfile(events, lifecycles)[0].occurrenceCount, 1);
    });
    it('keeps diagnostic files with the same basename in different directories separate', () => {
        const events = [observation(1, [known('C:/ws/a/lib.h'), known('C:/ws/b/lib.h')]), observation(2, [known('C:/ws/b/lib.h')])];
        const lives = buildErrorLifecycles(events);
        assert.strictEqual(lives.length, 2);
        assert.strictEqual(lives.filter(l => l.resolvedAt).length, 1);
        assert.strictEqual(lives.find(l => l.resolvedAt)?.warning?.diagnostic.file, 'C:/ws/a/lib.h');
    });
    it('does not merge the same header warning across compilation targets', () => {
        const lives = buildErrorLifecycles([observation(1, [known('C:/ws/lib.h')]), observation(2, [known('C:/ws/lib.h')], 'C:/other/main.cpp')]);
        assert.strictEqual(lives.length, 2);
        assert.ok(lives.every(l => !l.resolvedAt));
    });
    it('closes warning families independently even with identical messages', () => {
        const events = [observation(1, [known('main.cpp', 3, '-Walpha'), known('main.cpp', 3, '-Wbeta')]), observation(2, [known('main.cpp', 3, '-Wbeta')])];
        const lives = buildErrorLifecycles(events);
        assert.strictEqual(lives.length, 2);
        assert.strictEqual(lives.filter(l => l.resolvedAt).length, 1);
        assert.strictEqual(lives.find(l => l.resolvedAt)?.warning?.diagnostic.code, '-Walpha');
    });
    it('does not close a warning on legacy or partial observations', () => {
        const legacy = observation(2, []); delete legacy.parsedErrors; delete legacy.diagnosticsComplete;
        const partial = { ...observation(3, []), diagnosticsComplete: false };
        const view = buildJourneyViewModel([observation(1), legacy, partial, observation(4)]);
        assert.strictEqual(view.episodes.length, 1);
        assert.strictEqual(view.episodes[0].resolved, false);
        assert.strictEqual(view.episodes[0].entries.length, 4);
    });
    it('counts true recurrence as a second knowledge occurrence', () => {
        const events = [observation(1, [known()]), observation(2, []), observation(3, [known()])];
        const lives = buildErrorLifecycles(events);
        const card = mergeKnowledgeCards(events.flatMap(e => hasCompileDiagnostics(e) ? generateKnowledgeCard(e, events, lives) : []))[0];
        assert.strictEqual(card.frequency, 2);
        assert.strictEqual(card.resolvedCount, 1);
        assert.strictEqual(card.unresolvedCount, 1);
    });
    it('normalizes Windows URI and path spellings without dropping attempts', () => {
        const view = buildJourneyViewModel([observation(1, [known('C:/ws/main.cpp')]), observation(2, [known('c:/WS/main.cpp')], 'file:///c:/WS/main.cpp')]);
        assert.strictEqual(view.episodes.length, 1);
        assert.strictEqual(view.episodes[0].entries.length, 2);
    });
    it('does not guess a directory for relative headers', () => {
        const lives = buildErrorLifecycles([observation(1, [known('lib.h'), known('C:/ws/lib.h')])]);
        assert.strictEqual(lives.length, 2);
    });
    it('leaves raw historical events unchanged and accepts unsorted input', () => {
        const events = [observation(3, []), observation(1), observation(2)];
        const before = JSON.stringify(events);
        const lives = buildErrorLifecycles(events);
        assert.strictEqual(lives.length, 1);
        assert.strictEqual(lives[0].resolvedAt, 30000);
        assert.strictEqual(JSON.stringify(events), before);
    });
    it('retains the existing per-event Error lifecycle policy', () => {
        const events: DebugEvent[] = [1, 2].map(id => ({ ...observation(id, ['main.cpp:3:2: error: expected semicolon']), type: 'compile_error', stderr: 'main.cpp:3:2: error: expected semicolon', parsedErrors: parseCompilerStderrFull('main.cpp:3:2: error: expected semicolon'), exitCode: 1 }));
        assert.strictEqual(buildErrorLifecycles(events).length, 2);
    });
});

describe('Warning and Error tie ordering', () => {
    it('keeps a warning before an identically worded error in the original batch order', () => {
        const stderr = 'main.cpp:3:2: warning: duplicate wording\nmain.cpp:3:2: error: duplicate wording';
        const event: DebugEvent = { ...observation(1), type: 'compile_error', stderr, parsedErrors: parseCompilerStderrFull(stderr), exitCode: 1 };
        assert.deepStrictEqual(buildErrorLifecycles([event]).map(l => l.signature.severity), ['warning', 'error']);
    });
});
