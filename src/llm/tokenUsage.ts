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
		cacheHitTokens: (total?.cacheHitTokens ?? 0) + (next.cacheHitTokens ?? 0),
		cacheMissTokens: (total?.cacheMissTokens ?? 0) + (next.cacheMissTokens ?? 0),
	};
}
