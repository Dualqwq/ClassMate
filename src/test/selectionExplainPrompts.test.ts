import * as assert from 'assert';
import { describe, it } from 'mocha';
import {
	buildCodeExplainPrompt,
	buildCompileErrorSelectionPrompt,
	formatSelectionKnowledgeText,
	formatSelectionLocationLine,
} from '../chat/selectionExplainPrompts';
import type { ParsedError } from '../error/errorParser';

function makeParsedError(partial: Partial<ParsedError> & { raw: string; message: string }): ParsedError {
	return { ...partial };
}

describe('buildCompileErrorSelectionPrompt (划词解释中文提示词)', () => {
	it('开头指令保住「初学者能听懂」语义,原始报错逐字进无语言 tag 围栏', () => {
		const displayText = "main.cpp:5:9: error: 'x' was not declared in this scope";
		const prompt = buildCompileErrorSelectionPrompt({
			displayText,
			locationLine: '位置：main.cpp:5:9',
			knowledgeText: '- undeclared_identifier: 变量没有声明就使用了',
		});
		assert.ok(prompt.startsWith('请用初学者能听懂的话，帮我讲解下面这个编译错误：'));
		assert.ok(prompt.includes('原始报错：\n```\n' + displayText + '\n```'));
		assert.ok(prompt.includes('\n位置：main.cpp:5:9\n'));
		assert.ok(prompt.includes('已匹配到的知识点：\n- undeclared_identifier: 变量没有声明就使用了'));
	});

	it('多行报错文本与空行结构原样保留,不做任何改写', () => {
		const displayText = ['a.cpp:2:5: error: expected \';\' before \'}\' token', ' }', '     ^'].join('\n');
		const prompt = buildCompileErrorSelectionPrompt({
			displayText,
			locationLine: '位置：a.cpp:2:5',
			knowledgeText: '- missing_semicolon: 少写了分号',
		});
		assert.ok(prompt.includes(displayText));
		const rawBlock = prompt.split('原始报错：\n```\n')[1].split('\n```')[0];
		assert.strictEqual(rawBlock, displayText);
	});

	it('有模板链摘要行时附在报错块之后,无摘要时整段不出现', () => {
		const base = { displayText: 'err', locationLine: '位置：x', knowledgeText: '没有匹配到具体的知识点标签。' };
		const withSummary = buildCompileErrorSelectionPrompt({
			...base,
			templateSummary: '根因帧：main.cpp:7:14（required from here）；报错叶子：stl_algo.h:1914',
		});
		assert.ok(
			withSummary.includes(
				'```\n根因帧：main.cpp:7:14（required from here）；报错叶子：stl_algo.h:1914\n\n位置：x'
			)
		);
		const withoutSummary = buildCompileErrorSelectionPrompt(base);
		assert.ok(!withoutSummary.includes('根因帧'));
		assert.ok(withoutSummary.includes('```\nerr\n```\n位置：x'));
	});
});

describe('buildCodeExplainPrompt (划词解释中文提示词)', () => {
	it('语言 tag 原样进围栏信息串,代码逐字保留', () => {
		const code = ['int main() {', '\treturn 0;', '}'].join('\n');
		const prompt = buildCodeExplainPrompt('cpp', code);
		assert.strictEqual(
			prompt,
			'请帮我讲解下面这段代码：\n\n```cpp\nint main() {\n\treturn 0;\n}\n```'
		);
	});

	it('含中文/特殊字符的代码原样透传', () => {
		const code = 'printf("你好\\n"); // 注释';
		assert.ok(buildCodeExplainPrompt('cpp', code).includes('```cpp\n' + code + '\n```'));
	});
});

describe('formatSelectionLocationLine', () => {
	it('无法解析选区诊断时给明确兜底句', () => {
		assert.strictEqual(formatSelectionLocationLine(undefined), '位置：无法解析');
	});

	it('无模板链时位置即诊断行自身位置', () => {
		const parsed = makeParsedError({ raw: 'r', message: 'm', file: 'main.cpp', line: 12, column: 5 });
		assert.strictEqual(formatSelectionLocationLine(parsed), '位置：main.cpp:12:5');
	});

	it('有模板归因帧时讲学生代码行,叶子位置附注在后', () => {
		const parsed = makeParsedError({
			raw: 'r',
			message: 'm',
			file: 'stl_algo.h',
			line: 1914,
			column: 50,
			templateChain: {
				frames: [],
				attributed: {
					kind: 'here',
					file: 'main.cpp',
					line: 7,
					column: 14,
					isSystem: false,
					raw: 'required from here',
				},
			},
		});
		assert.strictEqual(
			formatSelectionLocationLine(parsed),
			'位置：main.cpp:7:14（根因在你写的这行代码里；报错叶子：stl_algo.h:1914）'
		);
	});

	it('文件名缺失时用「未知文件」占位,行列未知用 ?', () => {
		const parsed = makeParsedError({ raw: 'r', message: 'm' });
		assert.strictEqual(formatSelectionLocationLine(parsed), '位置：未知文件:?:?');
	});
});

describe('formatSelectionKnowledgeText', () => {
	it('按「- tag: message」逐行拼接,tag 标识符原样', () => {
		assert.strictEqual(
			formatSelectionKnowledgeText([
				{ tag: 'undeclared_identifier', message: '变量没有声明就使用了' },
				{ tag: 'missing_header', message: "fatal error: 'x.h' file not found" },
			]),
			'- undeclared_identifier: 变量没有声明就使用了\n- missing_header: fatal error: \'x.h\' file not found'
		);
	});

	it('无命中时给中性兜底句(不静默留空)', () => {
		assert.strictEqual(formatSelectionKnowledgeText([]), '没有匹配到具体的知识点标签。');
	});
});
