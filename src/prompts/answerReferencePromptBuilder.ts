import type { LLMMessage } from '../llm/types';

export interface AnswerReferencePromptInput {
	answer: string;
	files: Array<{
		path: string;
		symbols: Array<{ name: string; lines: Array<{ line: number; text: string }> }>;
	}>;
}

/**
 * 让 LLM 从最终回答中提取代码引用候选。
 * 正文保持自然行文(不要求 LLM 写 `sort`(main.cpp:23) 这种注解),
 * 消歧依赖回答上下文 + 每个文件的符号清单;控制器再做确定性校验。
 */
export class AnswerReferencePromptBuilder {
	public build(input: AnswerReferencePromptInput): LLMMessage[] {
		const system = [
			'=== ClassMate Answer Reference Extractor ===',
			'You are given the final teaching answer and the workspace files it may refer to.',
			'Extract the concrete code locations the answer points to. Rules:',
			'- "f" must be one of the given file paths. The answer rarely spells the path out; infer which file the mentioned symbol or line belongs to using the symbol list.',
			'- "s" is the symbol name — a function, class/struct/type, or other identifier — when the answer mentions one.',
			'- "l" must be exactly one of the lines listed for that symbol in that file. Prefer the definition line when the answer discusses the function itself; use the call/reference line when it points at a call site.',
			'- Never invent a line number that is not in the listed lines. Omit "l" when unsure.',
			'- "k" is "def" when the answer talks about a function definition or behavior, "call" when it points at a call site, "ref" otherwise. Omit when unsure.',
			'- Do NOT extract conceptual or algorithm mentions that are not tied to a concrete workspace file.',
			'- When in doubt, omit the entry. Prefer fewer, correct references.',
			'Reply with JSON only: {"r":[{"f":"...","s":"...","l":1,"k":"def"}]}',
		].join('\n');
		const user = JSON.stringify(
			{
				answer: input.answer,
				files: input.files.map((file) => ({
					path: file.path,
					symbols: file.symbols,
				})),
			},
			null,
			2
		);
		return [
			{ role: 'system', content: system },
			{ role: 'user', content: user },
		];
	}
}
