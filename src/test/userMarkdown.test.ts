import * as assert from 'assert';
import { describe, it } from 'mocha';
import { prepareUserMarkdown } from '../chat/userMarkdown';

describe('prepareUserMarkdown (用户气泡软换行 → 硬换行)', () => {
	it('单行消息零改动(快路径,不补任何空格)', () => {
		const oneLine = '老师，这行为什么报错？';
		assert.strictEqual(prepareUserMarkdown(oneLine), oneLine);
	});

	it('相邻两行非空:前行尾补两个空格成硬换行,换行数不变', () => {
		const input = '第一行内容\n第二行内容';
		const output = prepareUserMarkdown(input);
		assert.strictEqual(output, '第一行内容  \n第二行内容');
		assert.strictEqual(output.split('\n').length, input.split('\n').length);
	});

	it('空行分段:段落间的换行不补空格(段落语义保持)', () => {
		const input = '第一段\n\n第二段';
		assert.strictEqual(prepareUserMarkdown(input), '第一段\n\n第二段');
	});

	it('围栏代码块内换行原样保留,不补空格', () => {
		const input = ['看这段：', '```cpp', 'int x = 1;', 'int y = 2;', '```', '完了吗？'].join('\n');
		const output = prepareUserMarkdown(input);
		assert.strictEqual(
			output,
			['看这段：  ', '```cpp', 'int x = 1;', 'int y = 2;', '```', '完了吗？'].join('\n')
		);
	});

	it('围栏闭合后,围栏外正文恢复软换行转换', () => {
		const input = ['```', 'code line 1', 'code line 2', '```', '说明A', '说明B'].join('\n');
		const output = prepareUserMarkdown(input);
		assert.ok(output.includes('说明A  \n说明B'));
		assert.ok(output.includes('code line 1\ncode line 2'));
	});

	it('波浪线围栏同样识别', () => {
		const input = ['~~~', 'a', 'b', '~~~', 'x', 'y'].join('\n');
		const output = prepareUserMarkdown(input);
		assert.ok(output.includes('~~~\na\nb\n~~~'));
		assert.ok(output.includes('x  \ny'));
	});

	it('已是硬换行的行尾(两个空格 / 反斜杠)不再重复补', () => {
		assert.strictEqual(prepareUserMarkdown('已带两空格  \n下一行'), '已带两空格  \n下一行');
		assert.strictEqual(prepareUserMarkdown('反斜杠\\\n下一行'), '反斜杠\\\n下一行');
	});

	it('CRLF 换行归一为 LF 再处理', () => {
		assert.strictEqual(prepareUserMarkdown('第一行\r\n第二行'), '第一行  \n第二行');
	});

	it('行尾单个空格也会补成硬换行(共三个空格,markdown 仍识别)', () => {
		assert.strictEqual(prepareUserMarkdown('行尾有空格 \n下一行'), '行尾有空格   \n下一行');
	});

	it('换行后是空行/空白行时不补(下一段是块结构)', () => {
		assert.strictEqual(prepareUserMarkdown('第一行\n   \n第二行'), '第一行\n   \n第二行');
	});

	it('围栏开行带缩进与语言 tag 仍可识别并成对闭合', () => {
		const input = ['文字', '   ```cpp', 'int a;', '   ```', '后面', '再一行'].join('\n');
		const output = prepareUserMarkdown(input);
		assert.ok(output.includes('   ```cpp\nint a;\n   ```'));
		assert.ok(output.includes('后面  \n再一行'));
	});
});
