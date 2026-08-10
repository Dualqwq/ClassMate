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
			'Extract EVERY concrete code symbol the answer mentions explicitly: functions, member variables, class/struct/type names, base classes, and qualified names like X::Y.',
			'Rules:',
			'- "f" must be one of the given file paths. When a symbol exists in multiple files, use the answer context to pick the file (e.g., "从基类 Creature 继承的名字" points at creature.h; base-class members and base types resolve to the base class file).',
			'- "s" is the symbol name — a function, class/struct/type, member variable, or other identifier.',
			'- The student-facing answer was written against numbered file blocks: line numbers are 1-based file lines (e.g. "第 3 行" means the third line of the file).',
			'- "l" must be exactly one of the lines listed for that symbol in that file. Prefer the definition line when the answer discusses the function/class itself; use the call/reference line when it points at a call site; when the answer mentions a constructor like Monster(...), return the constructor line rather than the class declaration line.',
			'- For a qualified name like X::Y, return Y in the file where X is defined, on its definition/declaration line (k="def").',
			'- Never invent a line number that is not in the listed lines. Omit "l" when unsure.',
			'- "k" is "def" when the answer talks about a function definition or behavior, "call" when it points at a call site, "ref" otherwise. Omit when unsure.',
			'- "t" is what the symbol IS: "func" (function/method), "type" (class/struct/enum/union), "var" (variable/member/parameter), "macro" (macro/constant), "std" (standard-library symbol), "other" (anything else). Base it on the definition line in the file; omit when unsure.',
			'- Omit only mentions that are purely conceptual with no concrete symbol (e.g., "sorting algorithm" without naming any function). Do not be conservative: extract all explicit mentions, even member variables and base classes.',
			'Reply with JSON only: {"r":[{"f":"...","s":"...","l":1,"k":"def","t":"func"}]}',
		].join('\n');
		const user = JSON.stringify(
			{
				// 文件清单在前、回答在后:文件未变时清单逐轮一致,尽量留在 DeepSeek 前缀缓存里
				files: input.files.map((file) => ({
					path: file.path,
					symbols: file.symbols,
				})),
				answer: input.answer,
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
