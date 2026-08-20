import { z } from 'zod';
import { parseJsonObject } from '../graph/schemas';

/** 引用提取节点返回的单个候选(短 wire 格式)。 */
export const answerReferenceWireSchema = z.object({
	f: z.string().trim().min(1).max(500), // 相对文件路径
	s: z.string().trim().min(1).max(200).optional(), // 符号/函数名
	l: z.number().int().positive().max(10_000_000).optional(), // 1-based 行
	k: z.enum(['def', 'call', 'ref']).optional(), // 定义/调用/一般引用
	t: z.enum(['func', 'type', 'var', 'macro', 'std', 'other']).optional(), // 语义类型:函数/类型/变量/宏常量/标准库/其他
}).strict();

/** 引用提取节点返回的整体结构。 */
export const answerReferencesWireSchema = z.object({
	r: z.array(answerReferenceWireSchema).max(20).default([]),
}).strict();

/**
 * 截断抢救(诊断取证 2026-08-20:600 token 上限把全文件枚举型回答的
 * 提取响应在条目中间硬截断,此前整包丢弃导致引用静默归零)。
 * 扫描 r 数组找最后一个完整对象的边界,闭合括号后重解析:截断前
 * 已完整的条目全部可用,截在半条的丢弃;逐条按 wire schema 校验,
 * 超上限(20)取前 20,与 answerReferencesWireSchema 的上限一致。
 * 抢救不出任何完整条目时返回 undefined(由调用方决定上抛)。
 */
export function salvageTruncatedReferences(
	raw: string
): { r: Array<z.infer<typeof answerReferenceWireSchema>> } | undefined {
	const arrayStart = raw.indexOf('[');
	if (arrayStart < 0) {
		return undefined;
	}
	let inString = false;
	let escaped = false;
	let depth = 0;
	let lastCompleteObjectEnd = -1;
	for (let index = arrayStart; index < raw.length; index++) {
		const char = raw[index];
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (char === '\\') {
				escaped = true;
			} else if (char === '"') {
				inString = false;
			}
			continue;
		}
		if (char === '"') {
			inString = true;
		} else if (char === '{') {
			depth++;
		} else if (char === '}') {
			depth--;
			if (depth === 0) {
				// 顶层(数组内)对象完整闭合:记录候选边界。
				lastCompleteObjectEnd = index;
			}
		}
	}
	if (lastCompleteObjectEnd < 0) {
		return undefined;
	}
	const body = raw.slice(arrayStart + 1, lastCompleteObjectEnd + 1).replace(/,\s*$/, '');
	let items: unknown[];
	try {
		items = JSON.parse(`[${body}]`) as unknown[];
	} catch {
		return undefined;
	}
	const valid = items
		.map((item) => answerReferenceWireSchema.safeParse(item))
		.filter((result) => result.success)
		.map((result) => result.data)
		.slice(0, 20);
	return valid.length > 0 ? { r: valid } : undefined;
}

export { parseJsonObject };
