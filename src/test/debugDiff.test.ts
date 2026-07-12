import * as assert from 'assert';
import { describe, it } from 'mocha';
import { computeLineDiff } from '../debug/diff';

describe('Line Diff Utility', () => {
    it('returns empty string for identical inputs', () => {
        const result = computeLineDiff('a\nb\nc', 'a\nb\nc');
        assert.strictEqual(result, '');
    });

    it('marks removed lines with minus and added lines with plus', () => {
        const result = computeLineDiff('a\nb\nc', 'a\nb2\nc');
        assert.ok(result.includes('- b'));
        assert.ok(result.includes('+ b2'));
    });

    it('handles empty before text', () => {
        const result = computeLineDiff('', 'a\nb');
        assert.strictEqual(result, '+ a\n+ b');
    });
});
