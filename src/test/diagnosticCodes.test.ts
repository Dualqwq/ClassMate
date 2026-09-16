import * as assert from 'assert';
import { describe, it } from 'mocha';
import { extractErrorLocation } from '../error/errorParser';

describe('Parameterized diagnostic codes', () => {
    for (const code of ['-Woverloaded-virtual=', '-Woverloaded-virtual=2']) {
        it(`parses ${code} without changing the raw diagnostic`, () => {
            const raw = `creature.h:90:18: warning: virtual method was hidden [${code}]`;
            const parsed = extractErrorLocation(raw);
            assert.strictEqual(parsed?.code, code);
            assert.strictEqual(parsed?.message, 'virtual method was hidden');
            assert.strictEqual(parsed?.raw, raw);
        });
    }
    it('prefers a parameterized warning over generic -Werror in multiple codes', () => {
        const parsed = extractErrorLocation('a.cpp:1:2: error: hidden [-Werror, -Woverloaded-virtual=2]');
        assert.strictEqual(parsed?.code, '-Woverloaded-virtual=2');
        assert.strictEqual(parsed?.message, 'hidden');
    });
    it('does not strip arbitrary bracketed prose', () => {
        const parsed = extractErrorLocation('a.cpp:1:2: warning: problem [value = other]');
        assert.strictEqual(parsed?.code, undefined);
        assert.strictEqual(parsed?.message, 'problem [value = other]');
    });
});
