import * as React from 'react';
import type { MistakeCardVM } from '../../../src/journey/journeyViewModel';
import { MistakeCard } from './MistakeCard';
import { sortMistakeCards, type MistakeSortMode } from '../../../src/journey/journeyFilters';
import { sendMessage } from '../vscodeApi';

/**
 * 错题本页签(#14a,设计稿 §6.1):排序栏 + 卡片列表。
 * 分组维度固定知识标签(problemKey 规则未定,schema Q4 退化为按工作区,
 * 每张卡本身就是一次标签聚合);导出接通既有 classmate.exportDebugNotebook
 * 命令通路(LLM 聚合发送 + 学生显式触发 + 自选保存位置)。
 */
export const MistakeBookTab: React.FC<{ cards: MistakeCardVM[] }> = ({ cards }) => {
	const [sortMode, setSortMode] = React.useState<MistakeSortMode>('recommended');
	const visible = sortMistakeCards(cards, sortMode);

	return (
		<div className="journey-mistake-book">
			<div className="journey-filter-bar">
				<span className="journey-section-title">按知识标签整理({visible.length})</span>
				<span className="journey-spacer" />
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
				visible.map((card) => <MistakeCard key={card.tag} card={card} />)
			)}
		</div>
	);
};
