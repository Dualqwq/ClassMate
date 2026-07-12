import * as assert from 'assert';
import { describe, it } from 'mocha';
import {
    createErrorSignature,
    normalizeErrorMessage,
    signaturesMatch,
} from '../debug/errorFingerprint';

describe('Error Fingerprint', () => {
    it('normalizes messages by lowercasing and replacing identifiers', () => {
        const result = normalizeErrorMessage("'x' was not declared in this scope");
        assert.strictEqual(result, '<id> was not declared in this scope');
    });

    it('normalizes messages by replacing numbers and identifiers', () => {
        const result = normalizeErrorMessage("'x' was not declared in this scope at line 42");
        assert.strictEqual(result, "<id> was not declared in this scope at line <num>");
    });

    it('creates a signature with knowledge tags', () => {
        const parsed = {
            raw: "main.cpp:5:10: error: 'x' was not declared in this scope",
            file: 'main.cpp',
            line: 5,
            column: 10,
            severity: 'error' as const,
            message: "'x' was not declared in this scope",
        };
        const signature = createErrorSignature(parsed);
        assert.strictEqual(signature.normalizedMessage, '<id> was not declared in this scope');
        assert.deepStrictEqual(signature.knowledgeTags, ['undeclared_identifier']);
    });

    it('matches signatures with fuzzy mode ignoring line numbers', () => {
        const a = createErrorSignature({
            raw: 'err',
            message: "'x' was not declared in this scope",
            severity: 'error',
        });
        const b = createErrorSignature({
            raw: 'err',
            message: "'y' was not declared in this scope",
            severity: 'error',
        });
        assert.ok(signaturesMatch(a, b, { mode: 'fuzzy' }));
    });

    it('does not match different messages in fuzzy mode', () => {
        const a = createErrorSignature({ raw: 'err', message: 'missing semicolon', severity: 'error' });
        const b = createErrorSignature({ raw: 'err', message: 'undefined reference', severity: 'error' });
        assert.strictEqual(signaturesMatch(a, b, { mode: 'fuzzy' }), false);
    });

    it('matches signatures with knowledge mode', () => {
        const a = createErrorSignature({ raw: 'err', message: "'x' was not declared in this scope", severity: 'error' });
        const b = createErrorSignature({ raw: 'err', message: "'y' was not declared in this scope", severity: 'error' });
        assert.ok(signaturesMatch(a, b, { mode: 'knowledge' }));
    });

    it('respects strict mode with diagnostic codes', () => {
        const a = createErrorSignature(
            { raw: 'err', message: 'unused variable', severity: 'warning' },
            { includeCode: true }
        );
        a.code = '-Wunused-variable';
        const b = createErrorSignature(
            { raw: 'err', message: 'unused variable', severity: 'warning' },
            { includeCode: true }
        );
        b.code = '-Wunused-parameter';
        assert.strictEqual(signaturesMatch(a, b, { mode: 'strict' }), false);
    });
});
