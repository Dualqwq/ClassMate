import type { LLMMessage } from '../llm/types';

export interface AnswerReferencePromptInput {
	answer: string;
	files: Array<{ path: string; symbols: string[] }>;
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
			'- "s" is the symbol or function name when the answer mentions one.',
			'- "l" is the 1-based line number when the answer gives one or it is clearly identifiable; otherwise omit it.',
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
