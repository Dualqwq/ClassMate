import * as assert from 'assert';
import { describe, it } from 'mocha';
import { classifyDocumentLanguage, isCFamilyLanguage } from '../config/languageConfig';

describe('language classification', () => {
    it('recognizes C and C++ as supported source languages', () => {
        assert.strictEqual(classifyDocumentLanguage('c'), 'c');
        assert.strictEqual(classifyDocumentLanguage('cpp'), 'cpp');
        assert.strictEqual(isCFamilyLanguage('c'), true);
        assert.strictEqual(isCFamilyLanguage('cpp'), true);
    });

    it('keeps Markdown and plain text outside C/C++ features', () => {
        assert.strictEqual(classifyDocumentLanguage('markdown'), 'markdown');
        assert.strictEqual(classifyDocumentLanguage('plaintext'), 'text');
        assert.strictEqual(isCFamilyLanguage('markdown'), false);
        assert.strictEqual(isCFamilyLanguage('plaintext'), false);
    });
});
