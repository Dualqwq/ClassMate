import * as assert from 'assert';
import * as path from 'path';
import { describe, it } from 'mocha';
import { parseDebugCommand, resolveDebugOutputPath } from '../chat/debugCommand';

describe('parseDebugCommand', () => {
	it('parses bare debug commands', () => {
		assert.deepStrictEqual(parseDebugCommand('//show-ref'), { command: 'show-ref' });
		assert.deepStrictEqual(parseDebugCommand('  //show-usage  '), { command: 'show-usage' });
		assert.deepStrictEqual(parseDebugCommand('//knowledge-cards'), {
			command: 'knowledge-cards',
		});
		assert.deepStrictEqual(parseDebugCommand('//show-prompts'), {
			command: 'show-prompts',
		});
		assert.deepStrictEqual(parseDebugCommand('//export-diagnostics'), {
			command: 'export-diagnostics',
		});
	});

	it('parses a command with a file path', () => {
		assert.deepStrictEqual(parseDebugCommand('//show-log out.txt'), {
			command: 'show-log',
			filePath: 'out.txt',
		});
		assert.deepStrictEqual(parseDebugCommand('//show-journey C:/tmp/journey.md'), {
			command: 'show-journey',
			filePath: 'C:/tmp/journey.md',
		});
		assert.deepStrictEqual(parseDebugCommand('//show-ref my folder/out.log'), {
			command: 'show-ref',
			filePath: 'my folder/out.log',
		});
		assert.deepStrictEqual(parseDebugCommand('//show-prompts prompts.json'), {
			command: 'show-prompts',
			filePath: 'prompts.json',
		});
		assert.deepStrictEqual(parseDebugCommand('//export-diagnostics bug1-real.json'), {
			command: 'export-diagnostics',
			filePath: 'bug1-real.json',
		});
	});

	it('returns undefined for non-debug text', () => {
		assert.strictEqual(parseDebugCommand('// 注释'), undefined);
		assert.strictEqual(parseDebugCommand('how does this work?'), undefined);
		assert.strictEqual(parseDebugCommand(''), undefined);
		assert.strictEqual(parseDebugCommand('//'), undefined);
	});

	it('resolves relative debug paths under the workspace log directory', () => {
		assert.strictEqual(
			resolveDebugOutputPath('p2.txt', {
				workspaceRoot: 'C:/ws',
				activeFileDir: 'C:/ws/src',
				cwd: 'C:/',
			}),
			path.join('C:/ws', 'log', 'p2.txt')
		);
		assert.strictEqual(
			resolveDebugOutputPath('sub/p1.txt', {
				workspaceRoot: 'C:/ws',
				activeFileDir: 'C:/ws/src',
				cwd: 'C:/',
			}),
			path.join('C:/ws', 'log', 'sub', 'p1.txt')
		);
	});

	it('prefers the fixed debug output directory over the workspace root', () => {
		assert.strictEqual(
			resolveDebugOutputPath('p2.txt', {
				debugOutputDir: 'C:/proj/log',
				workspaceRoot: 'C:/ws',
				activeFileDir: 'C:/ws/src',
				cwd: 'C:/',
			}),
			path.join('C:/proj/log', 'p2.txt')
		);
	});

	it('falls back to the active file directory and then cwd for relative paths', () => {
		assert.strictEqual(
			resolveDebugOutputPath('p1.txt', {
				activeFileDir: 'C:/src',
				cwd: 'C:/',
			}),
			path.join('C:/src', 'log', 'p1.txt')
		);
		assert.strictEqual(
			resolveDebugOutputPath('p1.txt', { cwd: 'C:/fallback' }),
			path.join('C:/fallback', 'log', 'p1.txt')
		);
	});

	it('keeps absolute paths unchanged', () => {
		assert.strictEqual(
			resolveDebugOutputPath('C:/tmp/out.txt', {
				workspaceRoot: 'C:/ws',
				activeFileDir: 'C:/ws/src',
				cwd: 'C:/',
			}),
			'C:/tmp/out.txt'
		);
	});
});
