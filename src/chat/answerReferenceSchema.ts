import { z } from 'zod';
import { parseJsonObject } from '../graph/schemas';

/** 引用提取节点返回的单个候选(短 wire 格式)。 */
export const answerReferenceWireSchema = z.object({
	f: z.string().trim().min(1).max(500), // 相对文件路径
	s: z.string().trim().min(1).max(200).optional(), // 符号/函数名
	l: z.number().int().positive().max(10_000_000).optional(), // 1-based 行
	k: z.enum(['def', 'call', 'ref']).optional(), // 定义/调用/一般引用
}).strict();

/** 引用提取节点返回的整体结构。 */
export const answerReferencesWireSchema = z.object({
	r: z.array(answerReferenceWireSchema).max(20).default([]),
}).strict();

export { parseJsonObject };
