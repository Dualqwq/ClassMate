import * as React from 'react';
import type { JourneyMetricsVM } from '../../../src/journey/journeyViewModel';

/**
 * 指标条(#12a,设计稿 §4.1):buildJourneySummary 指标的学生友好化呈现。
 * 措辞纪律:不出现 lifecycle/签名等内部术语;求助比例用鼓励性措辞,
 * 不做惩罚性展示(设计稿 §4.3 防依赖)。
 *
 * 「已修好/没解决」计数来自 summarizeEpisodesBySeverity(跟随当前筛选,
 * 错误/警告分开写);记录总数与求助比例是事件级全量口径,不随筛选变化。
 */
export const JourneyMetricsBar: React.FC<{
	metrics: JourneyMetricsVM;
	severitySummary?: {
		resolved: number;
		unresolved: number;
		unresolvedErrors: number;
		unresolvedWarnings: number;
	};
}> = ({ metrics, severitySummary }) => {
	const { totalEvents, resolvedErrors, unresolvedErrors, avgFixAttempts, helpSeekingRatio } =
		metrics;
	const helpPercent = Math.round(helpSeekingRatio * 100);
	const resolved = severitySummary?.resolved ?? resolvedErrors;
	const unresolved = severitySummary?.unresolved ?? unresolvedErrors;

	return (
		<div className="journey-metrics-bar">
			<span className="journey-metric">
				记录了 <strong>{totalEvents}</strong> 条调试动态
			</span>
			<span className="journey-metric">
				已修好 <strong>{resolved}</strong> 个错
				{unresolved > 0 ? (
					<>
						,还有 <strong className="journey-metric-warn">{unresolved}</strong> 个没解决
						{severitySummary && (
							<span className="journey-metric-split">
								({severitySummary.unresolvedErrors > 0 &&
									`错误 ${severitySummary.unresolvedErrors}`}
								{severitySummary.unresolvedErrors > 0 &&
									severitySummary.unresolvedWarnings > 0 &&
									' · '}
								{severitySummary.unresolvedWarnings > 0 &&
									`警告 ${severitySummary.unresolvedWarnings}`}
								)
							</span>
						)}
					</>
				) : (
					resolved + totalEvents > 0 && ',没有攒着的错'
				)}
			</span>
			{resolvedErrors > 0 && (
				<span className="journey-metric">
					平均试 <strong>{avgFixAttempts.toFixed(1)}</strong> 次修好一个
				</span>
			)}
			{totalEvents > 0 && (
				<span className="journey-metric">
					{helpPercent}% 的错误你求助过 AI
					{helpSeekingRatio <= 0.5 && helpPercent > 0 && ',多数时候先自己想了办法'}
					{helpSeekingRatio <= 0 && resolvedErrors > 0 && ',全靠自己修好的'}
				</span>
			)}
		</div>
	);
};
