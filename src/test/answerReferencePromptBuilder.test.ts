import * as assert from 'assert';
import { describe, it } from 'mocha';
import { AnswerReferencePromptBuilder } from '../prompts/answerReferencePromptBuilder';

describe('AnswerReferencePromptBuilder', () => {
	it('includes the answer, file paths, symbols and extraction rules', () => {
		const messages = new AnswerReferencePromptBuilder().build({
			answer: 'sort 函数的时间复杂度是 O(n log n)',
			files: [
				{
					path: 'main.cpp',
					symbols: [
						{ name: 'sort', lines: [{ line: 2, text: 'void sort(int* a, int n) {' }] },
						{ name: 'quickSort', lines: [] },
					],
				},
			],
		});

		assert.strictEqual(messages.length, 2);
		assert.strictEqual(messages[0].role, 'system');
		assert.strictEqual(messages[1].role, 'user');

		const system = messages[0].content;
		assert.ok(system.includes('"f" must be one of the given file paths'));
		assert.ok(system.includes('"l" must be exactly one of the lines listed'));
		assert.ok(system.includes('Never invent a line number'));
		assert.ok(system.includes('Extract EVERY concrete code symbol'));
		assert.ok(system.includes('base classes'));
		assert.ok(system.includes('constructor'));
		assert.ok(system.includes('qualified name like X::Y'));
		assert.ok(system.includes('Reply with JSON only'));

		const user = messages[1].content;
		assert.ok(user.includes('sort 函数的时间复杂度是 O(n log n)'));
		assert.ok(user.includes('main.cpp'));
		assert.ok(user.includes('sort'));
		assert.ok(user.includes('quickSort'));
	});
});
