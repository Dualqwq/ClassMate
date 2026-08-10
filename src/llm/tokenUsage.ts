import type { LLMTokenUsage } from './types';

/**
 * 累加一次 LangGraph 流程里多次模型调用的 token 用量。
 * RouteAndPlan、Answer 等节点都会调用模型，界面应该展示它们的总和，
 * 而不是只展示最后一次调用。
 */
export function addTokenUsage(
	total: LLMTokenUsage | undefined,
	next: LLMTokenUsage
): LLMTokenUsage {
	const inputTokens = (total?.inputTokens ?? 0) + next.inputTokens;
	const outputTokens = (total?.outputTokens ?? 0) + next.outputTokens;
	return {
		inputTokens,
		outputTokens,
		totalTokens: (total?.totalTokens ?? 0)
			+ (next.totalTokens ?? next.inputTokens + next.outputTokens),
		// provider 未返回缓存字段时保持 undefined,而不是累加成 0:
		// 只有全部调用都报告了对应字段才求和,否则保留已报告的那一个。
		cacheHitTokens:
			total?.cacheHitTokens !== undefined && next.cacheHitTokens !== undefined
				? total.cacheHitTokens + next.cacheHitTokens
				: (total?.cacheHitTokens ?? next.cacheHitTokens),
		cacheMissTokens:
			total?.cacheMissTokens !== undefined && next.cacheMissTokens !== undefined
				? total.cacheMissTokens + next.cacheMissTokens
				: (total?.cacheMissTokens ?? next.cacheMissTokens),
	};
}
