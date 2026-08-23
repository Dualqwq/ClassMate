import * as React from 'react';
import type { MistakeCardVM } from '../../../src/journey/journeyViewModel';
import { sendMessage } from '../vscodeApi';

/**
 * 错题本一张复习卡(#14a,设计稿 §6.1):三档渐进展开——
 * 第一档(默认)只给现象与知识标签 → 「先自己想想」展开常见原因/检查方法
 * (第二档) → 仍需要才展开自己上次的修复 diff(第三档,只读,不提供应用)。
 * 每档展开都是学生的显式点击,无定时器、无自动展开;展开状态不跨会话记忆
 * (开放问题 Q8=A:每次进页签全部折叠,复习的价值在重新回忆)。
 */

function formatLastSeen(timestamp: number): string {
	const now = new Date();
	const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
	if (timestamp >= startOfToday) {
		return `今天 ${new Date(timestamp).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })}`;
	}
	if (timestamp >= startOfToday - 86_400_000) {
		return '昨天';
	}
	return `${new Date(timestamp).getMonth() + 1}月${new Date(timestamp).getDate()}日`;
}

function buildHintText(card: MistakeCardVM): string {
	return `关于「${card.title}」这个知识点：我最近反复在同类错误上卡住，最新一次是「${card.phenomenon}」。请帮我梳理排查思路，先不要给完整代码。`;
}

export const MistakeCard: React.FC<{ card: MistakeCardVM }> = ({ card }) => {
	// 三档:0=现象(默认) 1=+原因/检查方法 2=+自己的修复样例。不持久化。
	const [stage, setStage] = React.useState(0);
	const unresolved = card.unresolvedCount > 0;

	return (
		<div className={`journey-mistake-card ${unresolved ? 'unresolved' : 'resolved'}`}>
			<div className="journey-episode-head">
				<span className={`journey-status-badge ${unresolved ? 'pending' : 'ok'}`}>
					{unresolved ? '未解决' : '已解决'}
				</span>
				{card.frequency > 1 && (
					<span
						className="journey-chain-badge"
						title={`同一个知识点累计出现过 ${card.frequency} 次`}
					>
						第 {card.frequency} 次犯
					</span>
				)}
				<span className="journey-mistake-title" title={card.tag}>
					{card.title}
				</span>
			</div>
			<div className="journey-episode-summary">
				最近:{formatLastSeen(card.lastSeenAt)}
				{card.frequency > 1 ? ` · 本题累计 ${card.frequency} 次` : ''}
				{card.viaIncludes && card.viaIncludes.length > 0 && (
					<span className="journey-via-includes">
						{' '}· 经 {card.viaIncludes.slice().reverse().join(' → ')} 引入
					</span>
				)}
			</div>

			<div className="journey-review-box">
				<div className="journey-review-stage">
					<div className="journey-review-label">现象</div>
					<p className="journey-review-phenomenon">{card.phenomenon}</p>
					{stage === 0 && (
						<button className="journey-button journey-reveal-button" onClick={() => setStage(1)}>
							先自己想想：这通常在说什么？(点开看解析)
						</button>
					)}
				</div>
				{stage >= 1 && (
					<div className="journey-review-stage">
						<div className="journey-review-label">常见原因 / 检查方法</div>
						<ul className="journey-cause-list">
							{card.commonCauses.map((cause) => (
								<li key={cause}>{cause}</li>
							))}
						</ul>
						<p className="journey-check-method">{card.checkMethod}</p>
						{stage === 1 && card.fixes.length > 0 && (
							<button className="journey-button journey-reveal-button" onClick={() => setStage(2)}>
								还是想不起来？看我上次的改法
							</button>
						)}
					</div>
				)}
				{stage >= 2 && (
					<div className="journey-review-stage">
						<div className="journey-review-label">
							我上次的改法({card.fixes.length} 条,只读回放)
						</div>
						{card.fixes.map((fix, index) => (
							<details key={index} className="journey-fix-diff">
								<summary>修改样例 {index + 1}</summary>
								<pre>{fix.diff || `${fix.before}\n→\n${fix.after}`}</pre>
							</details>
						))}
						{card.fixes.length === 0 && (
							<p className="journey-entry-empty">这个错误还没有留下你自己的修复记录。</p>
						)}
					</div>
				)}
			</div>

			<div className="journey-action-row">
				{card.fileUri && (
					<button
						className="journey-button"
						onClick={() =>
							sendMessage({ type: 'journey:openFile', uri: card.fileUri!, line: card.line })
						}
					>
						在代码里看
					</button>
				)}
				<button
					className="journey-button"
					onClick={() =>
						sendMessage({ type: 'journey:requestHint', text: buildHintText(card) })
					}
				>
					求提示
				</button>
			</div>
		</div>
	);
};
