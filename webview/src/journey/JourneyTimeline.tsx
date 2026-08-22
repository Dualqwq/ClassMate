import * as React from 'react';
import type { JourneyEpisodeVM } from '../../../src/journey/journeyViewModel';
import { EpisodeCard } from './EpisodeCard';
import type { EpisodeDayGroup } from '../../../src/journey/journeyFilters';

/**
 * episode 时间线(#12a):未解决置顶区(唯一的主动引导——呈现学生自己的
 * 未完成事实) + 已解决按日折叠。默认展开「今天」,其余日期点击展开;
 * 新事件经 sync 到达时不自动滚动、不抢焦点。
 */
export const JourneyTimeline: React.FC<{
	unresolved: JourneyEpisodeVM[];
	byDay: EpisodeDayGroup[];
}> = ({ unresolved, byDay }) => {
	if (unresolved.length === 0 && byDay.length === 0) {
		return null;
	}
	return (
		<div className="journey-timeline">
			{unresolved.length > 0 && (
				<section className="journey-unresolved-section">
					<div className="journey-section-title">还没解决({unresolved.length})</div>
					{unresolved.map((episode) => (
						<EpisodeCard key={episode.errorEventId} episode={episode} />
					))}
				</section>
			)}
			{byDay.map((group) => (
				<details key={group.label} className="journey-day-group" open={group.label === '今天'}>
					<summary>{group.label}({group.episodes.length})</summary>
					{group.episodes.map((episode) => (
						<EpisodeCard key={episode.errorEventId} episode={episode} />
					))}
				</details>
			))}
		</div>
	);
};
