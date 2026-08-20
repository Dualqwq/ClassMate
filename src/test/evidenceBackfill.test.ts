import * as assert from 'assert';
import { describe, it } from 'mocha';
import {
	MAX_EVIDENCE_BACKFILL_ROUNDS,
	planEvidenceBackfill,
} from '../workspace/evidenceBackfill';
import type { LoadedWorkspaceItem, MinimalWorkspaceContext } from '../workspace/types';

function minimalOf(paths: string[], activeFile?: string): MinimalWorkspaceContext {
	return {
		catalog: {
			files: paths.map((path) => ({
				path,
				uri: `file:///${path}`,
				kind: path.endsWith('.md') ? 'text' : 'code',
				size: 10,
				modifiedAt: 1,
			})),
			questionFiles: [],
			...(activeFile
				? {
					activeEditor: {
						fileName: activeFile,
						uri: `file:///${activeFile}`,
						languageId: 'cpp',
					},
				}
				: {}),
		},
	};
}

function loadedOf(paths: string[]): LoadedWorkspaceItem[] {
	return paths.map((path) => ({
		path,
		kind: 'code',
		content: 'int x;',
		contentHash: `hash-${path}`,
		reason: 'test',
	}));
}

describe('planEvidenceBackfill (7.8 缺证据补读)', () => {
	it('plans a load when the user names an unloaded code file', () => {
		const plan = planEvidenceBackfill({
			userText: '帮我看看 monster.h 里的 takeTurn',
			requestType: 'code_explanation',
			minimal: minimalOf(['monster.h', 'player.h']),
			loadedItems: loadedOf(['player.h']),
			processedTargets: new Set(),
			backfillCount: 0,
		});
		assert.ok(plan);
		assert.strictEqual(plan!.reason, 'named_file_missing');
		assert.strictEqual(plan!.requests[0].target, 'monster.h');
	});

	it('falls back to the active code file when no code item is loaded for a code question', () => {
		const plan = planEvidenceBackfill({
			userText: '这个函数哪里有问题',
			requestType: 'code_explanation',
			minimal: minimalOf(['monster.h', 'notes.md'], 'monster.h'),
			loadedItems: [],
			processedTargets: new Set(),
			backfillCount: 0,
		});
		assert.ok(plan);
		assert.strictEqual(plan!.reason, 'no_code_loaded');
		assert.strictEqual(plan!.requests[0].target, 'monster.h');
	});

	it('does nothing for concept questions without a named file', () => {
		const plan = planEvidenceBackfill({
			userText: '什么是指针',
			requestType: 'concept_explanation',
			minimal: minimalOf(['monster.h'], 'monster.h'),
			loadedItems: [],
			processedTargets: new Set(),
			backfillCount: 0,
		});
		assert.strictEqual(plan, undefined);
	});

	it('never plans a target that was already requested or backfilled', () => {
		const plan = planEvidenceBackfill({
			userText: '看看 monster.h',
			requestType: 'code_explanation',
			minimal: minimalOf(['monster.h']),
			loadedItems: [],
			processedTargets: new Set(['monster.h']),
			backfillCount: 0,
		});
		assert.strictEqual(plan, undefined, '已请求过的目标不重复补读');
	});

	it('respects the two-round budget', () => {
		const plan = planEvidenceBackfill({
			userText: '看看 monster.h',
			requestType: 'code_explanation',
			minimal: minimalOf(['monster.h']),
			loadedItems: [],
			processedTargets: new Set(),
			backfillCount: MAX_EVIDENCE_BACKFILL_ROUNDS,
		});
		assert.strictEqual(plan, undefined, '配额用尽后不再补读');
	});

	it('ignores stems that are too short to be meaningful', () => {
		const plan = planEvidenceBackfill({
			userText: 'a 是什么',
			requestType: 'code_explanation',
			minimal: minimalOf(['a.h']),
			loadedItems: [],
			processedTargets: new Set(),
			backfillCount: 0,
		});
		assert.strictEqual(plan, undefined);
	});
});
