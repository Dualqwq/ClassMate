import * as assert from 'assert';
import { describe, it } from 'mocha';
import {
	buildUnloadedBoundary,
	normalizeLineEndings,
	numberedLines,
	pickFence,
	renderNativeFileBlock,
} from '../prompts/nativeWorkspaceRenderer';

describe('nativeWorkspaceRenderer', () => {
	it('normalizes CRLF and CR to LF before numbering', () => {
		assert.strictEqual(normalizeLineEndings('a\r\nb\rc'), 'a\nb\nc');
	});

	it('renders 1-based numbered lines', () => {
		const lines = numberedLines(
			'#include <bits10_1.h>\nusing namespace std;\nusing namespace std;'
		);
		assert.deepStrictEqual(lines, [
			'   1 | #include <bits10_1.h>',
			'   2 | using namespace std;',
			'   3 | using namespace std;',
		]);
	});

	it('returns no lines for empty content', () => {
		assert.deepStrictEqual(numberedLines(''), []);
	});

	it('picks a fence token absent from the content', () => {
		assert.strictEqual(pickFence('int main() {}'), '```');
		assert.strictEqual(pickFence('a ``` b'), '~~~');
		assert.strictEqual(pickFence('a ``` b ~~~ c'), '````');
		assert.strictEqual(pickFence('```\n~~~\n````\n`````'), '``````');
	});

	it('renders a file as metadata JSON line plus fenced numbered block', () => {
		const block = renderNativeFileBlock({
			path: 'a.cpp',
			kind: 'code',
			content: 'int main() { return 0; }',
			contentHash: 'h1',
			reason: 'active',
		});
		const lines = block.split('\n');
		assert.strictEqual(
			lines[0],
			'{"path":"a.cpp","kind":"code","contentHash":"h1","reason":"active"}'
		);
		assert.strictEqual(lines[1], '```');
		assert.strictEqual(lines[2], '   1 | int main() { return 0; }');
		assert.strictEqual(lines[3], '```');
	});

	it('marks empty files explicitly', () => {
		const block = renderNativeFileBlock({
			path: 'empty.cpp',
			kind: 'code',
			content: '',
		});
		assert.match(block, /\[empty file\]/);
	});

	it('keeps reason after contentHash so a volatile reason does not break the stable prefix', () => {
		const block = renderNativeFileBlock({
			path: 'a.cpp',
			kind: 'code',
			content: 'x',
			contentHash: 'h',
			reason: 'r',
		});
		const metadata = block.split('\n')[0];
		assert.ok(
			metadata.indexOf('"contentHash"') < metadata.indexOf('"reason"'),
			'reason must come after contentHash'
		);
	});

	it('builds the unloaded boundary as catalog-minus-loaded, sorted, excluding CLASSMATE.md', () => {
		const catalog = {
			files: [
				{ path: 'b.cpp', uri: 'file:///b.cpp', kind: 'code' as const, size: 10, modifiedAt: 1 },
				{ path: 'a.cpp', uri: 'file:///a.cpp', kind: 'code' as const, size: 20, modifiedAt: 1 },
				{ path: 'question.md', uri: 'file:///question.md', kind: 'question' as const, size: 5, modifiedAt: 1 },
				{ path: 'CLASSMATE.md', uri: 'file:///CLASSMATE.md', kind: 'text' as const, size: 3, modifiedAt: 1 },
			],
			questionFiles: [],
		};
		const boundary = buildUnloadedBoundary(catalog, [{ path: 'a.cpp' }]);
		assert.deepStrictEqual(
			boundary.unloaded.map((entry) => entry.path),
			['b.cpp', 'question.md']
		);
		assert.strictEqual(boundary.omittedCount, 0);
	});

	it('caps the unloaded list and reports the omitted count', () => {
		const files = Array.from({ length: 150 }, (_, index) => ({
			path: `f${String(index).padStart(3, '0')}.cpp`,
			uri: `file:///f${String(index).padStart(3, '0')}.cpp`,
			kind: 'code' as const,
			size: 1,
			modifiedAt: 1,
		}));
		const boundary = buildUnloadedBoundary({ files, questionFiles: [] }, []);
		assert.strictEqual(boundary.unloaded.length, 100);
		assert.strictEqual(boundary.omittedCount, 50);
	});
});
