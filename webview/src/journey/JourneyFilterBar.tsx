import * as React from 'react';
import { EMPTY_FILTER, ENTRY_TYPE_LABELS, SEVERITY_LEVEL_LABELS, type JourneyEntryKind, type JourneyFilterState, type SeverityLevel } from '../../../src/journey/journeyFilters';

/**
 * 过滤栏(#12a):条目类型多选 + 级别多选(错误/警告) + 文件下拉 +
 * 「只看未解决」开关。过滤是纯前端状态(设计稿 §4.2):数据已在手,
 * 变更不回 extension 重取;不持久化,面板重开回到全量。
 */
export const JourneyFilterBar: React.FC<{
	filter: JourneyFilterState;
	onChange: (next: JourneyFilterState) => void;
	fileOptions: Array<{ value: string; label: string }>;
}> = ({ filter, onChange, fileOptions }) => {
	const toggleType = (kind: JourneyEntryKind) => {
		const has = filter.types.includes(kind);
		const nextTypes = has
			? filter.types.filter((k) => k !== kind)
			: [...filter.types, kind];
		if (nextTypes.length === 0) {
			return; // 至少保留一档,避免"全取消后整页消失"的困惑态。
		}
		onChange({ ...filter, types: nextTypes });
	};

	const toggleLevel = (level: SeverityLevel) => {
		const has = filter.levels.includes(level);
		const nextLevels = has
			? filter.levels.filter((l) => l !== level)
			: [...filter.levels, level];
		if (nextLevels.length === 0) {
			return; // 同上:级别至少保留一档。
		}
		onChange({ ...filter, levels: nextLevels });
	};

	return (
		<div className="journey-filter-bar">
			<div className="journey-filter-types" role="group" aria-label="按动态类型过滤">
				{(Object.keys(ENTRY_TYPE_LABELS) as JourneyEntryKind[]).map((kind) => (
					<button
						key={kind}
						className={`journey-chip ${filter.types.includes(kind) ? 'on' : ''}`}
						onClick={() => toggleType(kind)}
						aria-pressed={filter.types.includes(kind)}
					>
						{ENTRY_TYPE_LABELS[kind]}
					</button>
				))}
			</div>
			<div className="journey-filter-levels" role="group" aria-label="按级别过滤">
				{(Object.keys(SEVERITY_LEVEL_LABELS) as SeverityLevel[]).map((level) => (
					<button
						key={level}
						className={`journey-chip journey-sev-chip-${level} ${filter.levels.includes(level) ? 'on' : ''}`}
						onClick={() => toggleLevel(level)}
						aria-pressed={filter.levels.includes(level)}
					>
						{SEVERITY_LEVEL_LABELS[level]}
					</button>
				))}
			</div>
			<select
				className="journey-file-select"
				value={filter.file}
				onChange={(event) => onChange({ ...filter, file: event.target.value })}
				aria-label="按文件过滤"
			>
				<option value="all">全部文件</option>
				{fileOptions.map((option) => (
					<option key={option.value} value={option.value}>
						{option.label}
					</option>
				))}
			</select>
			<label className="journey-toggle">
				<input
					type="checkbox"
					checked={filter.unresolvedOnly}
					onChange={(event) =>
						onChange({ ...filter, unresolvedOnly: event.target.checked })
					}
				/>
				只看未解决
			</label>
			<button
				className="journey-mini-button"
				onClick={() => onChange({ ...EMPTY_FILTER })}
				title="恢复全部显示"
			>
				重置
			</button>
		</div>
	);
};
