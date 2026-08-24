import * as React from 'react';
import type { JourneyEpisodeVM, JourneyEntryVM } from '../../../src/journey/journeyViewModel';
import { sendMessage } from '../vscodeApi';

/**
 * 时间线一张 episode 卡(#12a,设计稿 §4.1):错误现象行 + 生命周期摘要 +
 * 条目时间线 + 动作区。未解决卡只呈现事实与入口,不出现任何「修复剧透」。
 */

function formatClock(timestamp: number): string {
	return new Date(timestamp).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
}

function formatFirstSeen(timestamp: number): string {
	const now = new Date();
	const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
	const clock = formatClock(timestamp);
	if (timestamp >= startOfToday) {
		return `今天 ${clock}`;
	}
	if (timestamp >= startOfToday - 86_400_000) {
		return `昨天 ${clock}`;
	}
	return `${new Date(timestamp).getMonth() + 1}月${new Date(timestamp).getDate()}日 ${clock}`;
}

function buildHintText(episode: JourneyEpisodeVM): string {
	const location = episode.fileName
		? `(${episode.fileName}${episode.line ? `:${episode.line}` : ''})`
		: '';
	return `我在修这个错但一直没搞定：「${episode.message}」${location}。请先告诉我下一步应该从哪里排查，不要直接给完整代码。`;
}

const EntryLine: React.FC<{ entry: JourneyEntryVM }> = ({ entry }) => (
	<div className="journey-entry">
		<span className="journey-entry-time">{formatClock(entry.timestamp)}</span>
		<span className="journey-entry-label">{entry.label}</span>
		{entry.kind === 'code_modified' && entry.changedLines !== undefined && (
			<span className="journey-entry-extra">改 {entry.changedLines} 行</span>
		)}
		{entry.kind === 'code_modified' && (
			<button
				className="journey-mini-button"
				title="打开这次修改的只读对比"
				onClick={() => sendMessage({ type: 'journey:openDiff', eventId: entry.eventId })}
			>
				看 diff
			</button>
		)}
	</div>
);

export const EpisodeCard: React.FC<{ episode: JourneyEpisodeVM }> = ({ episode }) => {
	const severity = episode.severity ?? 'error';
	const severityBadge =
		severity === 'warning' ? '⚠ 警告' : severity === 'info' ? 'ℹ 信息' : '✗ 错误';
	const severityTitle =
		severity === 'warning'
			? '警告级别的问题'
			: severity === 'info'
				? '运行记录(非错误)'
				: '错误级别的问题';
	return (
		<div className={`journey-episode-card ${episode.resolved ? 'resolved' : 'unresolved'}`}>
			<div className="journey-episode-head">
				<span className={`journey-status-badge ${episode.resolved ? 'ok' : 'pending'}`}>
					{episode.resolved ? '✓ 已解决' : '✗ 还没解决'}
				</span>
				<span
					className={`journey-sev-badge journey-sev-${severity}`}
					title={severityTitle}
				>
					{severityBadge}
				</span>
				<span className="journey-episode-message" title={episode.message}>
					{episode.message || '(没有解析出具体错误信息)'}
				</span>
				{episode.fileName && (
					<button
						className="journey-location-link"
						title="打开文件并定位到这一行"
						onClick={() =>
							sendMessage({
								type: 'journey:openFile',
								uri: episode.fileUri!,
								line: episode.line,
							})
						}
					>
						{episode.fileName}
						{episode.line ? `:${episode.line}` : ''}
					</button>
				)}
			</div>
			<div className="journey-episode-summary">
				{formatFirstSeen(episode.firstSeenAt)} 首次出现 ·{' '}
				{episode.severity === 'info'
					? '运行正常结束'
					: episode.resolved
						? `编译 ${episode.attemptsBeforeResolve} 次后修好`
						: '还没有等到修复'}
				{episode.viaIncludes && episode.viaIncludes.length > 0 && (
					<span className="journey-via-includes">
						· 经 {episode.viaIncludes.slice().reverse().join(' → ')} 引入
					</span>
				)}
			</div>
			<div className="journey-entry-list">
				{episode.entries.map((entry) => (
					<EntryLine key={`${entry.kind}-${entry.eventId}`} entry={entry} />
				))}
				{episode.entries.length === 0 && (
					<div className="journey-entry-empty">这个错误之后还没有相关动态。</div>
				)}
			</div>
			<div className="journey-action-row">
				{episode.fileUri && (
					<button
						className="journey-button"
						onClick={() =>
							sendMessage({
								type: 'journey:openFile',
								uri: episode.fileUri!,
								line: episode.line,
							})
						}
					>
						在代码里看
					</button>
				)}
				<button
					className="journey-button"
					onClick={() =>
						sendMessage({ type: 'journey:requestHint', text: buildHintText(episode) })
					}
				>
					求提示
				</button>
			</div>
		</div>
	);
};
