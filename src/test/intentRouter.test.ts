import * as assert from 'assert';
import { describe, it } from 'mocha';
import { classifyRequest } from '../prompts/intentRouter';

describe('Intent Router Test Suite', () => {
	it('frontend code_explanation intent is preserved', () => {
		const result = classifyRequest('code_explanation', '任意文本');
		assert.strictEqual(result, 'code_explanation');
	});

	it('frontend error_explanation intent infers compile error', () => {
		const result = classifyRequest('error_explanation', 'error: expected ";" before');
		assert.strictEqual(result, 'compile_error_help');
	});

	it('frontend error_explanation intent infers runtime error', () => {
		const result = classifyRequest('error_explanation', 'segmentation fault at line 5');
		assert.strictEqual(result, 'runtime_error_help');
	});

	it('frontend hint maps to problem_hint', () => {
		const result = classifyRequest('hint', '没思路');
		assert.strictEqual(result, 'problem_hint');
	});

	it('text analysis detects concept question', () => {
		const result = classifyRequest(undefined, '什么是指针？');
		assert.strictEqual(result, 'concept_explanation');
	});

	it('text analysis detects compile error keywords', () => {
		const result = classifyRequest(undefined, '编译报错 error: undeclared identifier');
		assert.strictEqual(result, 'compile_error_help');
	});

	it('text analysis detects no-idea keywords', () => {
		const result = classifyRequest(undefined, '完全没思路，不知道怎么开始');
		assert.strictEqual(result, 'problem_hint');
	});

	it('text analysis falls back to chat', () => {
		const result = classifyRequest(undefined, '你好');
		assert.strictEqual(result, 'chat');
	});
});
