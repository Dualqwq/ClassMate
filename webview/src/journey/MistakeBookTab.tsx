import * as React from 'react';
import type { MistakeCardVM } from '../../../src/journey/journeyViewModel';
import { MistakeCard } from './MistakeCard';
import {
    groupMistakeCards,
    sortMistakeCards,
    type MistakeGroupMode,
    type MistakeSortMode,
} from '../../../src/journey/journeyFilters';
import { sendMessage } from '../vscodeApi';

/**
 * 错题本页签(#14a,设计稿 §6.1):分组栏 + 排序栏 + 卡片列表。
 * 分组支持「按知识标签」(现状,每张卡一次标签聚合)与「按题目」
 * (#14b problemKey,由文件名派生);「让 AI 带我复盘」(#13 后半)发
 * journey:requestReview 预填复习草稿(只预填不发送);导出接通既有
 * classmate.exportDebugNotebook 命令通路(LLM 聚合发送 + 学生显式触发 +
 * 自选保存位置)。
 */
export const MistakeBookTab: React.FC<{ cards: MistakeCardVM[] }> = ({ cards }) => {
	const [sortMode, setSortMode] = React.useState<MistakeSortMode>('recommended');
	const [groupMode, setGroupMode] = React.useState<MistakeGroupMode>('tag');
	const visible = sortMistakeCards(cards, sortMode);
	const groups = groupMistakeCards(visible, groupMode);

	return (
		<div className="journey-mistake-book">
			<div className="journey-filter-bar">
				<span className="journey-section-title">
					{groupMode === 'problemKey'
						? `按题目整理(${groups.length})`
						: `按知识标签整理(${visible.length})`}
				</span>
				<span className="journey-spacer" />
				<select
					className="journey-file-select"
					value={groupMode}
					onChange={(event) => setGroupMode(event.target.value as MistakeGroupMode)}
					aria-label="分组方式"
				>
					<option value="tag">按知识标签</option>
					<option value="problemKey">按题目</option>
				</select>
				<select
					className="journey-file-select"
					value={sortMode}
					onChange={(event) => setSortMode(event.target.value as MistakeSortMode)}
					aria-label="排序方式"
				>
					<option value="recommended">推荐序(未解决优先)</option>
					<option value="recent">最近出现优先</option>
				</select>
				<button
					className="journey-button"
					onClick={() => sendMessage({ type: 'journey:requestReview' })}
					title="让 AI 把你反复出错的知识点串起来讲一遍(只预填草稿,由你确认发送)"
				>
					让 AI 带我复盘
				</button>
				<button
					className="journey-button"
					onClick={() => sendMessage({ type: 'journey:exportNotebook' })}
					title="生成错题本 Markdown,保存位置由你选择"
				>
					导出错题本
				</button>
			</div>
			{visible.length === 0 ? (
				<div className="journey-empty">
					错题本还是空的。遇到编译错误并修复后,这里会把它们整理成可以复习的知识卡片。
				</div>
			) : (
				groups.map((group) =>
					groupMode === 'problemKey' ? (
						<div key={group.key || '(none)'} className="journey-mistake-group">
							<div className="journey-mistake-group-title">
								{group.label}({group.cards.length})
							</div>
							{group.cards.map((card) => (
								<MistakeCard key={`${group.key}-${card.tag}`} card={card} />
							))}
						</div>
					) : (
						<MistakeCard key={group.cards[0].tag} card={group.cards[0]} />
					)
				)
			)}
		</div>
	);
};
