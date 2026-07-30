import * as assert from 'assert';
import { describe, it } from 'mocha';
import { looksLikeCodeEditRequest } from '../chat/codeEditIntent';

describe('code edit intent detection', () => {
	it('recognizes an explicit request to edit code', () => {
		assert.strictEqual(looksLikeCodeEditRequest('请帮我修改这个函数'), true);
		assert.strictEqual(looksLikeCodeEditRequest('修复当前代码'), true);
		assert.strictEqual(looksLikeCodeEditRequest('please fix this function'), true);
	});

	it('keeps questions about modification directions as tutoring requests', () => {
		assert.strictEqual(
			looksLikeCodeEditRequest('请指出位置、原因和最小修改方向，不要给完整代码'),
			false
		);
		assert.strictEqual(looksLikeCodeEditRequest('为什么会出错，怎么修复？'), false);
		assert.strictEqual(looksLikeCodeEditRequest('how should I fix this?'), false);
	});
});
