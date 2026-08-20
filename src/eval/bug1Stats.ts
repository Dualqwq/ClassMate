/**
 * bug1 live eval 运行统计(7.9 扩大测试):对 checkpoint 的逐轮记录做
 * token 用量与首字延迟聚合。纯函数,供判卷页与 scripts/bug1-stats.mjs 共用。
 */

export interface Bug1StatsUsage {
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
	cacheHitTokens?: number;
	cacheMissTokens?: number;
}

export interface Bug1StatsResult {
	conversationId?: string;
	turn?: number;
	status?: string;
	deliveryOutcome?: string;
	firstTokenMs?: number;
	/** 首字可见延迟:流式轮=真实首 token,缓冲交付轮=图完成时刻。 */
	firstVisibleMs?: number;
	totalDurationMs?: number;
	graphDurationMs?: number;
	usage?: Bug1StatsUsage;
	usageByNode?: Record<string, Bug1StatsUsage>;
}

export interface LatencyStats {
	count: number;
	avg: number;
	p50: number;
	p95: number;
	max: number;
}

export interface Bug1PerCaseStats {
	conversationId: string;
	turns: number;
	inputTokens: number;
	outputTokens: number;
	cacheHitTokens: number;
	avgFirstTokenMs?: number;
	avgGraphDurationMs: number;
}

export interface Bug1RunStats {
	turns: number;
	turnsWithModelUsage: number;
	byOutcome: Array<{ outcome: string; count: number }>;
	inputTokens: number;
	outputTokens: number;
	cacheHitTokens: number;
	cacheHitRatio: number;
	perNode: Array<{
		node: string;
		inputTokens: number;
		outputTokens: number;
	}>;
	firstTokenMs?: LatencyStats;
	graphDurationMs: LatencyStats;
	perCase: Bug1PerCaseStats[];
}

function readUsage(value: unknown): Bug1StatsUsage {
	if (!value || typeof value !== 'object') {
		return {};
	}
	return value as Bug1StatsUsage;
}

function percentile(sorted: number[], ratio: number): number {
	if (sorted.length === 0) {
		return 0;
	}
	const index = Math.min(
		sorted.length - 1,
		Math.ceil(sorted.length * ratio) - 1
	);
	return sorted[index];
}

function latencyOf(values: number[]): LatencyStats {
	const sorted = [...values].sort((left, right) => left - right);
	const sum = sorted.reduce((total, value) => total + value, 0);
	return {
		count: sorted.length,
		avg: sorted.length > 0 ? Math.round(sum / sorted.length) : 0,
		p50: percentile(sorted, 0.5),
		p95: percentile(sorted, 0.95),
		max: sorted.length > 0 ? sorted[sorted.length - 1] : 0,
	};
}

export function summarizeBug1Run(results: Bug1StatsResult[]): Bug1RunStats {
	const outcomeCounts = new Map<string, number>();
	const nodeUsage = new Map<string, { inputTokens: number; outputTokens: number }>();
	const caseStats = new Map<string, {
		turns: number;
		inputTokens: number;
		outputTokens: number;
		cacheHitTokens: number;
		firstTokens: number[];
		graphDurations: number[];
	}>();
	let inputTokens = 0;
	let outputTokens = 0;
	let cacheHitTokens = 0;
	let turnsWithModelUsage = 0;
	const firstTokenValues: number[] = [];
	const graphDurations: number[] = [];

	for (const result of results) {
		const outcome = result.deliveryOutcome ?? 'unknown';
		outcomeCounts.set(outcome, (outcomeCounts.get(outcome) ?? 0) + 1);

		const total = result.usage ?? Object.values(result.usageByNode ?? {})
			.reduce<Bug1StatsUsage>((sum, entry) => ({
				inputTokens: (sum.inputTokens ?? 0) + (entry.inputTokens ?? 0),
				outputTokens: (sum.outputTokens ?? 0) + (entry.outputTokens ?? 0),
				cacheHitTokens: (sum.cacheHitTokens ?? 0) + (entry.cacheHitTokens ?? 0),
			}), {});
		if ((total.inputTokens ?? 0) > 0 || (total.outputTokens ?? 0) > 0) {
			turnsWithModelUsage++;
		}
		inputTokens += total.inputTokens ?? 0;
		outputTokens += total.outputTokens ?? 0;
		cacheHitTokens += total.cacheHitTokens ?? 0;

		for (const [node, entry] of Object.entries(result.usageByNode ?? {})) {
			const usage = readUsage(entry);
			const current = nodeUsage.get(node) ?? { inputTokens: 0, outputTokens: 0 };
			current.inputTokens += usage.inputTokens ?? 0;
			current.outputTokens += usage.outputTokens ?? 0;
			nodeUsage.set(node, current);
		}

		if (typeof result.firstVisibleMs === 'number') {
			// 首字可见延迟(流式轮的真实首 token 或缓冲轮的图完成时刻)。
			firstTokenValues.push(result.firstVisibleMs);
		} else if (typeof result.firstTokenMs === 'number') {
			// 旧数据只有流式首 token;缓冲轮无记录时不计入(宁缺毋滥)。
			firstTokenValues.push(result.firstTokenMs);
		}
		if (typeof result.graphDurationMs === 'number') {
			graphDurations.push(result.graphDurationMs);
		}

		const caseId = result.conversationId ?? 'unknown';
		const current = caseStats.get(caseId) ?? {
			turns: 0,
			inputTokens: 0,
			outputTokens: 0,
			cacheHitTokens: 0,
			firstTokens: [],
			graphDurations: [],
		};
		current.turns++;
		current.inputTokens += total.inputTokens ?? 0;
		current.outputTokens += total.outputTokens ?? 0;
		current.cacheHitTokens += total.cacheHitTokens ?? 0;
		if (typeof result.firstVisibleMs === 'number' || typeof result.firstTokenMs === 'number') {
			current.firstTokens.push(result.firstVisibleMs ?? result.firstTokenMs!);
		}
		if (typeof result.graphDurationMs === 'number') {
			current.graphDurations.push(result.graphDurationMs);
		}
		caseStats.set(caseId, current);
	}

	return {
		turns: results.length,
		turnsWithModelUsage,
		byOutcome: [...outcomeCounts.entries()]
			.map(([outcome, count]) => ({ outcome, count }))
			.sort((left, right) => right.count - left.count),
		inputTokens,
		outputTokens,
		cacheHitTokens,
		cacheHitRatio: inputTokens > 0
			? Math.round((cacheHitTokens / inputTokens) * 1000) / 10
			: 0,
		perNode: [...nodeUsage.entries()]
			.map(([node, usage]) => ({ node, ...usage }))
			.sort((left, right) => right.inputTokens - left.inputTokens),
		firstTokenMs: firstTokenValues.length > 0
			? latencyOf(firstTokenValues)
			: undefined,
		graphDurationMs: latencyOf(graphDurations),
		perCase: [...caseStats.entries()]
			.map(([conversationId, stats]) => ({
				conversationId,
				turns: stats.turns,
				inputTokens: stats.inputTokens,
				outputTokens: stats.outputTokens,
				cacheHitTokens: stats.cacheHitTokens,
				avgFirstTokenMs: stats.firstTokens.length > 0
					? Math.round(
						stats.firstTokens.reduce((sum, value) => sum + value, 0)
						/ stats.firstTokens.length
					)
					: undefined,
				avgGraphDurationMs: stats.graphDurations.length > 0
					? Math.round(
						stats.graphDurations.reduce((sum, value) => sum + value, 0)
						/ stats.graphDurations.length
					)
					: 0,
			}))
			.sort((left, right) => left.conversationId.localeCompare(right.conversationId)),
	};
}

function formatTokens(value: number): string {
	return value >= 10_000
		? `${(value / 1000).toFixed(1)}k`
		: String(value);
}

/** 终端/文档用 Markdown 汇报(测试完的统计报告)。 */
export function formatBug1StatsMarkdown(stats: Bug1RunStats): string {
	const lines: string[] = [];
	lines.push(`## 运行统计(${stats.turns} 轮,含模型用量 ${stats.turnsWithModelUsage} 轮)`);
	lines.push('');
	lines.push(`- 交付结果:${stats.byOutcome
		.map((entry) => `${entry.outcome} × ${entry.count}`)
		.join(' · ')}`);
	lines.push(`- token 用量:输入 ${formatTokens(stats.inputTokens)}(缓存命中 ${stats.cacheHitRatio}%) · 输出 ${formatTokens(stats.outputTokens)}`);
	if (stats.firstTokenMs) {
		const latency = stats.firstTokenMs;
		lines.push(`- 首字延迟(可见):avg ${(latency.avg / 1000).toFixed(1)}s · p50 ${(latency.p50 / 1000).toFixed(1)}s · p95 ${(latency.p95 / 1000).toFixed(1)}s · max ${(latency.max / 1000).toFixed(1)}s(${latency.count} 轮有记录)`);
	} else {
		lines.push('- 首字延迟(可见):无记录');
	}
	lines.push(`- 图耗时:avg ${(stats.graphDurationMs.avg / 1000).toFixed(1)}s · p95 ${(stats.graphDurationMs.p95 / 1000).toFixed(1)}s · max ${(stats.graphDurationMs.max / 1000).toFixed(1)}s`);
	if (stats.perNode.length > 0) {
		lines.push('');
		lines.push('| 节点 | 输入 token | 输出 token |');
		lines.push('| --- | --- | --- |');
		for (const node of stats.perNode) {
			lines.push(`| ${node.node} | ${formatTokens(node.inputTokens)} | ${formatTokens(node.outputTokens)} |`);
		}
	}
	if (stats.perCase.length > 0) {
		lines.push('');
		lines.push('| 用例 | 轮次 | 输入 | 输出 | 首字 avg | 图耗时 avg |');
		lines.push('| --- | --- | --- | --- | --- | --- |');
		for (const item of stats.perCase) {
			lines.push(`| ${item.conversationId} | ${item.turns} | ${formatTokens(item.inputTokens)} | ${formatTokens(item.outputTokens)} | ${item.avgFirstTokenMs !== undefined ? `${(item.avgFirstTokenMs / 1000).toFixed(1)}s` : '—'} | ${(item.avgGraphDurationMs / 1000).toFixed(1)}s |`);
		}
	}
	return lines.join('\n');
}
