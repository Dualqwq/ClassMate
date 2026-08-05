import * as assert from 'assert';
import { describe, it } from 'mocha';
import { filterEventsToExistingFiles } from '../debug/debugJourneyFileFilter';
import type { DebugEvent } from '../debug/types';

function makeCompileError(id: string, fileUri: string | undefined): DebugEvent {
	return {
		id,
		type: 'compile_error',
		timestamp: 1,
		sessionId: 's1',
		workspaceId: 'ws',
		fileUri,
		stderr: 'main.cpp:1:1: error: boom',
		parsedErrors: [
			{
				raw: 'main.cpp:1:1: error: boom',
				file: 'main.cpp',
				line: 1,
				column: 1,
				severity: 'error',
				message: 'boom',
			},
		],
		exitCode: 1,
		durationMs: 100,
	};
}

describe('Debug Journey file filter', () => {
	it('drops events whose file no longer exists and keeps existing ones', async () => {
		const events: DebugEvent[] = [
			makeCompileError('e1', 'file:///main.cpp'),
			makeCompileError('e2', 'file:///deleted.cpp'),
			makeCompileError('e3', 'file:///main.cpp'),
		];
		const exists = async (uri: string) => uri === 'file:///main.cpp';

		const filtered = await filterEventsToExistingFiles(events, exists);
		assert.deepStrictEqual(
			filtered.map((e) => e.id),
			['e1', 'e3']
		);
	});

	it('keeps events without a fileUri (Other files group)', async () => {
		const events: DebugEvent[] = [
			makeCompileError('e1', undefined),
			makeCompileError('e2', 'file:///gone.cpp'),
		];
		const exists = async () => false;

		const filtered = await filterEventsToExistingFiles(events, exists);
		assert.deepStrictEqual(
			filtered.map((e) => e.id),
			['e1']
		);
	});

	it('checks each unique file key only once', async () => {
		const events: DebugEvent[] = [
			makeCompileError('e1', 'file:///main.cpp'),
			makeCompileError('e2', 'file:///main.cpp'),
			makeCompileError('e3', 'file:///helper.cpp'),
		];
		const checked: string[] = [];
		const exists = async (uri: string) => {
			checked.push(uri);
			return true;
		};

		await filterEventsToExistingFiles(events, exists);
		assert.deepStrictEqual(checked.sort(), ['file:///helper.cpp', 'file:///main.cpp']);
	});

	it('returns an empty list for empty events', async () => {
		const filtered = await filterEventsToExistingFiles([], async () => true);
		assert.deepStrictEqual(filtered, []);
	});
});
