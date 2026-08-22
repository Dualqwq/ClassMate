import * as React from 'react';
import type { JourneyViewModel } from '../../../src/journey/journeyViewModel';
import { sendMessage, subscribeToExtension } from '../vscodeApi';
import { EMPTY_FILTER, buildTimelineSections, collectFileOptions, type JourneyFilterState } from '../../../src/journey/journeyFilters';
import { JourneyMetricsBar } from './JourneyMetricsBar';
import { JourneyFilterBar } from './JourneyFilterBar';
import { JourneyTimeline } from './JourneyTimeline';
import { MistakeBookTab } from './MistakeBookTab';

/**
 * Journey 路由页(#12a/#14a):调试历程大屏,与 Chat/Run 同级的 WebviewPanel
 * 内嵌「时间线 | 错题本」两个页签(同一 store、同一派生层,一次 journey:sync
 * 推送两页签共用,页签切换纯前端)。
 *
 * 数据通路(设计稿 §3.3):面板不读 store;extension 侧取事件 → 派生纯函数 →
 * 节流推 sync,这里整体替换渲染。视图本身全是被动呈现:打开才出现,
 * 新事件到达只整体刷新,不弹窗、不闪动、不自动滚动。
 */
export const JourneyView: React.FC = () => {
	const [view, setView] = React.useState<JourneyViewModel | null>(null);
	const [tab, setTab] = React.useState<'timeline' | 'mistakes'>('timeline');
	const [filter, setFilter] = React.useState<JourneyFilterState>({ ...EMPTY_FILTER });

	React.useEffect(() => {
		const unsubscribe = subscribeToExtension((message) => {
			switch (message.type) {
				case 'journey:sync':
					setView(message.view);
					break;
				case 'journey:cleared':
					setView(null);
					setFilter({ ...EMPTY_FILTER });
					break;
			}
		});
		sendMessage({ type: 'journey:requestState' });
		return unsubscribe;
	}, []);

	const isEmpty = !view || (view.episodes.length === 0 && view.mistakeCards.length === 0);

	return (
		<div className="classmate-app journey-panel">
			<header className="classmate-header">
				<div className="classmate-header-row">
					<div className="classmate-brand">
						<div className="classmate-mark" aria-hidden="true">C</div>
						<div className="classmate-brand-copy">
							<div className="classmate-title">ClassMate 调试历程</div>
							<div className="classmate-subtitle">你的排错记录与错题本</div>
						</div>
					</div>
					<span className="classmate-spacer" />
					<button
						className="journey-button"
						title="清除本工作区的调试记录(需二次确认)"
						onClick={() => sendMessage({ type: 'journey:clearAll' })}
					>
						清除记录
					</button>
				</div>
				<div className="journey-tab-row" role="tablist" aria-label="调试历程页签">
					<button
						className={`journey-tab ${tab === 'timeline' ? 'active' : ''}`}
						role="tab"
						aria-selected={tab === 'timeline'}
						onClick={() => setTab('timeline')}
					>
						时间线
					</button>
					<button
						className={`journey-tab ${tab === 'mistakes' ? 'active' : ''}`}
						role="tab"
						aria-selected={tab === 'mistakes'}
						onClick={() => setTab('mistakes')}
					>
						错题本{view && view.mistakeCards.length > 0 ? `(${view.mistakeCards.length})` : ''}
					</button>
				</div>
			</header>

			{isEmpty ? (
				<div className="journey-empty">
					还没有调试记录。编译或运行一次代码后,你的排错过程会按时间线整理在这里;
					反复出现的错误会自动归进错题本。
				</div>
			) : view ? (
				tab === 'timeline' ? (
					<>
						<JourneyMetricsBar metrics={view.metrics} />
						<JourneyFilterBar
							filter={filter}
							onChange={setFilter}
							fileOptions={collectFileOptions(view)}
						/>
						<div className="journey-scroll">
							<JourneyTimeline {...buildTimelineSections(view, filter)} />
						</div>
					</>
				) : (
					<div className="journey-scroll">
						<MistakeBookTab cards={view.mistakeCards} />
					</div>
				)
			) : null}
		</div>
	);
};
