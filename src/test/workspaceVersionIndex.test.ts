import * as assert from 'assert';
import { describe, it } from 'mocha';
import {
	buildWorkspaceVersionIndex,
	diffWorkspaceVersions,
} from '../workspace/workspaceVersionIndex';
import type { LoadedWorkspaceItem, WorkspaceCatalog } from '../workspace/types';

function catalogOf(...files: Array<{ path: string; size: number; modifiedAt: number }>): WorkspaceCatalog {
	return {
		files: files.map((file) => ({
			path: file.path,
			uri: `file:///w/${file.path}`,
			kind: 'code',
			size: file.size,
			modifiedAt: file.modifiedAt,
		})),
		questionFiles: [],
	};
}

function loadedOf(path: string, contentHash: string): LoadedWorkspaceItem {
	return {
		path,
		kind: 'code',
		content: 'x',
		contentHash,
		reason: 'test',
	};
}

describe('workspace version index', () => {
	it('is stable while catalog metadata is unchanged', () => {
		const catalog = catalogOf({ path: 'monster.h', size: 100, modifiedAt: 5 });
		const first = buildWorkspaceVersionIndex(catalog, [loadedOf('monster.h', 'hash-a')]);
		const second = buildWorkspaceVersionIndex(catalog, [loadedOf('monster.h', 'hash-a')]);
		assert.deepStrictEqual(first, second);
	});

	it('detects created and deleted files', () => {
		const previous = buildWorkspaceVersionIndex(
			catalogOf({ path: 'a.cpp', size: 10, modifiedAt: 1 }),
			[]
		);
		const next = buildWorkspaceVersionIndex(
			catalogOf({ path: 'b.cpp', size: 10, modifiedAt: 1 }),
			[]
		);
		const changes = diffWorkspaceVersions(previous, next);
		assert.deepStrictEqual(
			changes.map((change) => [change.kind, change.path]).sort(),
			[['created', 'b.cpp'], ['deleted', 'a.cpp']]
		);
	});

	it('detects modification by content hash even when size is unchanged', () => {
		const previous = buildWorkspaceVersionIndex(
			catalogOf({ path: 'monster.h', size: 100, modifiedAt: 5 }),
			[loadedOf('monster.h', 'hash-old')]
		);
		const next = buildWorkspaceVersionIndex(
			catalogOf({ path: 'monster.h', size: 100, modifiedAt: 6 }),
			[loadedOf('monster.h', 'hash-new')]
		);
		const changes = diffWorkspaceVersions(previous, next);
		assert.deepStrictEqual(changes, [
			{ kind: 'modified', path: 'monster.h' },
		]);
	});

	it('detects modification by metadata for files that were never loaded', () => {
		const previous = buildWorkspaceVersionIndex(
			catalogOf({ path: 'util.h', size: 10, modifiedAt: 1 }),
			[]
		);
		const next = buildWorkspaceVersionIndex(
			catalogOf({ path: 'util.h', size: 12, modifiedAt: 1 }),
			[]
		);
		assert.deepStrictEqual(diffWorkspaceVersions(previous, next), [
			{ kind: 'modified', path: 'util.h' },
		]);
	});

	it('reports a rename when both sides carry the same content hash', () => {
		const previous = buildWorkspaceVersionIndex(
			catalogOf({ path: 'old_name.cpp', size: 50, modifiedAt: 1 }),
			[loadedOf('old_name.cpp', 'hash-same')]
		);
		const next = buildWorkspaceVersionIndex(
			catalogOf({ path: 'new_name.cpp', size: 50, modifiedAt: 1 }),
			[loadedOf('new_name.cpp', 'hash-same')]
		);
		assert.deepStrictEqual(diffWorkspaceVersions(previous, next), [
			{ kind: 'renamed', path: 'new_name.cpp', previousPath: 'old_name.cpp' },
		]);
	});

	it('does not claim a rename without matching content hashes', () => {
		const previous = buildWorkspaceVersionIndex(
			catalogOf({ path: 'old_name.cpp', size: 50, modifiedAt: 1 }),
			[]
		);
		const next = buildWorkspaceVersionIndex(
			catalogOf({ path: 'new_name.cpp', size: 50, modifiedAt: 1 }),
			[]
		);
		const changes = diffWorkspaceVersions(previous, next);
		assert.deepStrictEqual(
			changes.map((change) => change.kind).sort(),
			['created', 'deleted']
		);
	});
});
