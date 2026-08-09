import * as assert from 'assert';
import { describe, it } from 'mocha';
import { parseDebugCommand } from '../chat/debugCommand';

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
	});

	it('returns undefined for non-debug text', () => {
		assert.strictEqual(parseDebugCommand('// 注释'), undefined);
		assert.strictEqual(parseDebugCommand('how does this work?'), undefined);
		assert.strictEqual(parseDebugCommand(''), undefined);
		assert.strictEqual(parseDebugCommand('//'), undefined);
	});
});
