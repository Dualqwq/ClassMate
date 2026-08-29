import * as assert from 'assert';
import { describe, it } from 'mocha';
import { isBlockLevelCode } from '../chat/codeBlockRender';

describe('isBlockLevelCode (代码块块级/行内渲染判定)', () => {
	it('有 className(language-xxx)按块级渲染——带语言标注的围栏块', () => {
		assert.strictEqual(isBlockLevelCode('language-c', 'int main() {}'), true);
	});

	it('无 className 但文本含换行按块级渲染——无语言标注围栏块(返工回归关键用例)', () => {
		assert.strictEqual(isBlockLevelCode(undefined, 'int x = 1;\nint y = 2;'), true);
	});

	it('无 className 的单行文本按行内渲染(真行内 code span)', () => {
		assert.strictEqual(isBlockLevelCode(undefined, 'std::vector'), false);
	});

	it('className 为空串按行内处理,与 react-markdown 传空 class 的行为一致', () => {
		assert.strictEqual(isBlockLevelCode('', 'int x'), false);
	});

	it('className 为空串但文本含换行仍按块级渲染', () => {
		assert.strictEqual(isBlockLevelCode('', 'a\nb'), true);
	});

	it('CRLF(\\r\\n)文本含 \\n,按块级渲染', () => {
		assert.strictEqual(isBlockLevelCode(undefined, 'int x = 1;\r\nint y = 2;'), true);
	});

	it('text 为 undefined 且无 className 按行内渲染(防御:空节点)', () => {
		assert.strictEqual(isBlockLevelCode(undefined, undefined), false);
	});

	it('缩进代码块同样无 className 且含换行,按块级渲染', () => {
		assert.strictEqual(isBlockLevelCode(undefined, '    int indented = 0;\n    return 0;'), true);
	});
});
