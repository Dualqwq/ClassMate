import { logicalDiagnostics } from '../error/logicalDiagnostics';
import { buildJourneyHintText } from '../journey/episodePresentation';
import { buildJourneyDigest } from '../chat/journeyDigestBuilder';
import { buildErrorLifecycles } from '../debug/errorLifecycle';
import { aggregateErrorStats } from '../debug/analytics';
import { computeEventFingerprint } from '../debug/eventEnvelope';
import { buildNotebookInput } from '../debug/debugNotebook';
import type { DebugJourneyStore } from '../debug/debugJourneyStore';
import * as assert from 'assert';
import { describe, it } from 'mocha';
import { parseCompilerStderrFull } from '../error/templateBacktrace';
import { buildJourneyViewModel } from '../journey/journeyViewModel';
import type { CompileErrorEvent } from '../debug/types';

// GCC output replayed from the user's source with -std=c++17 -O2 -Wall.
const stderr = [
    'In file included from main.cpp:5:',
    "creature.h:90:18: warning: 'virtual void Creature::printStatus() const' was hidden [-Woverloaded-virtual=]",
    '   90 |     virtual void printStatus() const',
    '      |                  ^~~~~~~~~~~',
    'In file included from main.cpp:7:',
    "player.h:103:10: note:   by 'void Player::printStatus()'",
    "player.h: In constructor 'Player::Player(std::string, int, int)':",
    "player.h:15:9: warning: 'Player::max_energy_' will be initialized after [-Wreorder]",
    '   15 |     int max_energy_;',
    '      |         ^~~~~~~~~~~',
    "player.h:14:9: warning:   'int Player::energy_' [-Wreorder]",
    '   14 |     int energy_;',
    '      |         ^~~~~~~',
    'player.h:19:5: warning:   when initialized here [-Wreorder]',
    "player.h:68:17: warning: comparison of integer expressions of different signedness: 'int' and 'std::vector<Card>::size_type' [-Wsign-compare]",
    "player.h:96:26: warning: comparison of integer expressions of different signedness: 'int' and 'std::vector<Card>::size_type' [-Wsign-compare]",
    "main.cpp:75:34: error: 'class Monster' has no member named 'takeTurn'",
].join('\n');

function compileError(output = stderr): CompileErrorEvent {
    return { id: 'warning-replay', type: 'compile_error', timestamp: 1_000,
        sessionId: 's', workspaceId: 'ws', fileUri: 'main.cpp', stderr: output,
        parsedErrors: parseCompilerStderrFull(output), exitCode: 1, durationMs: 10 };
}

describe('Warning groups in Debug Journey', () => {
    it('does not turn the two reorder continuation lines into separate cards', () => {
        const view = buildJourneyViewModel([compileError()]);
        assert.ok(!view.episodes.some(e => /^'int Player::energy_'$|^when initialized here$/.test(e.message)));
        // Existing fuzzy signatures still merge the two equal sign-compare messages.
        assert.strictEqual(view.episodes.filter(e => e.severity === 'warning').length, 3);
        assert.strictEqual(view.episodes.filter(e => e.severity === 'error').length, 1);
        assert.ok(view.episodes.every(e => e.entries[0].label === '编译失败(1 个错误 · 4 个警告)'));
    });
    it('keeps complete Chinese explanations and all original locations for hints and the digest', () => {
        const event = compileError();
        const view = buildJourneyViewModel([event]);
        const reorder = view.episodes.find(e => e.message.startsWith('成员初始化顺序'))!;
        const hidden = view.episodes.find(e => e.message.startsWith('虚函数'))!;
        assert.ok(reorder.message.includes('Player::max_energy_'));
        assert.ok(reorder.message.includes('int Player::energy_'));
        assert.deepStrictEqual(reorder.diagnosticDetails?.map(d => d.line), [15, 14, 19]);
        assert.deepStrictEqual(hidden.diagnosticDetails?.map(d => [d.file, d.line]), [['creature.h', 90], ['player.h', 103]]);
        const hint = buildJourneyHintText(reorder);
        assert.ok(hint.includes('player.h:19'));
        assert.ok(hint.includes('when initialized here'));
        const digest = buildJourneyDigest([event], { nowMs: 2_000 });
        assert.ok(digest.includes('成员初始化顺序'));
        assert.ok(digest.includes("by 'void Player::printStatus()'"));
        assert.ok(digest.includes('player.h:103'));
    });

    it('uses one shared grouping for lifecycles, statistics and notebook export', async () => {
        const event = compileError();
        assert.strictEqual(buildErrorLifecycles([event]).length, 5);
        const stats = aggregateErrorStats([event]);
        assert.strictEqual(stats.bySeverity.warning, 4);
        assert.strictEqual(stats.byErrorCode['-Wreorder'], 1);
        const store = { workspaceId: 'ws', getEvents: async () => [event], getResolvedMarks: async () => ({}) } as unknown as DebugJourneyStore;
        const notebook = await buildNotebookInput(store);
        assert.strictEqual(notebook.summary.lifecycles.length, 5);
        assert.strictEqual(notebook.summary.errorStats.bySeverity.warning, 4);
    });

    it('normalizes old history without changing raw events or their stored/recomputed fingerprints', () => {
        const event = compileError();
        const hidden = event.parsedErrors.find(p => p.code === '-Woverloaded-virtual=')!;
        hidden.message += ' [-Woverloaded-virtual=]';
        delete hidden.code;
        hidden.viaIncludes = ['main.cpp:5'];
        event.fingerprint = computeEventFingerprint(event);
        const before = JSON.stringify(event);
        const oldFingerprint = event.fingerprint;
        const first = logicalDiagnostics(event);
        assert.strictEqual(first.find(p => p.explanation?.startsWith('虚函数'))?.code, '-Woverloaded-virtual=');
        assert.deepStrictEqual(logicalDiagnostics({ ...event, parsedErrors: first }), first);
        assert.deepStrictEqual(logicalDiagnostics(event), first);
        buildJourneyViewModel([event]);
        assert.strictEqual(JSON.stringify(event), before);
        assert.strictEqual(computeEventFingerprint(event), oldFingerprint);
        assert.strictEqual(event.fingerprint, oldFingerprint);
    });

    it('keeps the same root signature across repeated compiles and uses logical retry counts', () => {
        const first = compileError();
        const second = { ...compileError(), id: 'retry', timestamp: 20_000 };
        const view = buildJourneyViewModel([first, second]);
        const reorder = view.episodes.filter(e => e.message.startsWith('成员初始化顺序'));
        assert.strictEqual(reorder.length, 2);
        assert.ok(reorder.every(e => !e.resolved));
        assert.ok(reorder.find(e => e.errorEventId === first.id)!.entries.some(e => e.label === '再次编译失败(1 个错误 · 4 个警告)'));
    });

    const group = [
        "player.h:15:9: warning: 'Player::max_energy_' will be initialized after [-Wreorder]",
        "player.h:14:9: warning: 'int Player::energy_' [-Wreorder]",
        'player.h:19:5: warning: when initialized here [-Wreorder]',
    ];
    it('keeps two adjacent complete reorder groups distinct', () => {
        const second = group.map(line => line.replaceAll('Player', 'Enemy').replaceAll('player.h', 'enemy.h'));
        const logical = logicalDiagnostics(compileError([...group, ...second].join('\n')));
        assert.strictEqual(logical.length, 2);
        assert.ok(logical[0].explanation?.includes('Player'));
        assert.ok(!logical[0].explanation?.includes('Enemy'));
        assert.ok(logical[1].explanation?.includes('Enemy'));
    });
    for (const count of [1, 2]) {
        it(`keeps all ${count} diagnostics in an incomplete reorder group`, () => {
            const event = compileError(group.slice(0, count).join('\n'));
            assert.deepStrictEqual(logicalDiagnostics(event), event.parsedErrors);
        });
    }
    it('does not group warnings from different source files', () => {
        const event = compileError([group[0], group[1].replace('player.h', 'other.h'), group[2]].join('\n'));
        assert.deepStrictEqual(logicalDiagnostics(event), event.parsedErrors);
    });
    it('does not cross an unrelated warning or compiler context boundary', () => {
        for (const separator of ["other.h:2:1: warning: unused variable 'x' [-Wunused-variable]", "player.h: In constructor 'Other::Other()':", 'g++ -c other.cpp']) {
            const event = compileError([group[0], separator, group[1], group[2]].join('\n'));
            assert.deepStrictEqual(logicalDiagnostics(event), event.parsedErrors);
        }
    });
    it('does not group a different warning code or arbitrary short warning', () => {
        const event = compileError(group.join('\n').replaceAll('-Wreorder', '-Wsomething-else'));
        assert.deepStrictEqual(logicalDiagnostics(event), event.parsedErrors);
        const orphan = compileError("player.h:14:9: warning: 'int Player::energy_' [-Wreorder]");
        assert.strictEqual(buildJourneyViewModel([orphan]).episodes.length, 1);
    });
    it('does not infer grouping without raw boundary evidence', () => {
        const event = compileError(group.join('\n'));
        event.stderr = '';
        assert.deepStrictEqual(logicalDiagnostics(event), event.parsedErrors);
    });
    it('does not attach arbitrary notes or template backtrace notes', () => {
        for (const note of ['required from here', 'template argument deduction/substitution failed:', 'declared here']) {
            const event = compileError([
                "creature.h:90:18: warning: 'virtual void Creature::printStatus() const' was hidden [-Woverloaded-virtual=]",
                `player.h:103:10: note: ${note}`,
            ].join('\n'));
            assert.deepStrictEqual(logicalDiagnostics(event), event.parsedErrors);
        }
    });
    it('does not attach a hidden-method note across another translation unit', () => {
        const event = compileError(stderr.replace('In file included from main.cpp:7:', 'In file included from other.cpp:7:'));
        assert.strictEqual(logicalDiagnostics(event).find(p => p.code === '-Woverloaded-virtual=')?.diagnosticDetails, undefined);
    });
    it('preserves MSVC and unrelated Clang diagnostics', () => {
        const event = compileError('main.cpp(5,2): warning C4244: conversion may lose data\nmain.cpp:7:2: warning: unused variable [-Wunused-variable]\nmain.cpp:6:2: note: declared here');
        assert.deepStrictEqual(logicalDiagnostics(event), event.parsedErrors);
    });

});
