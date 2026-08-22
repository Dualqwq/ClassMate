import type { CoursewareRetrievalResult } from './types';

/**
 * 把课件检索结果格式化为模型可见的上下文块。
 */
export function formatCoursewareContext(results: CoursewareRetrievalResult[]): string {
	if (results.length === 0) {
		return '[No matching courseware fragments found.]';
	}
	const lines = ['=== Courseware context (from imported slides/notes) ==='];
	for (const result of results) {
		const pageLabel = result.pageStart === result.pageEnd
			? `p.${result.pageStart}`
			: `p.${result.pageStart}-${result.pageEnd}`;
		lines.push(`\n--- ${result.fileName} (${pageLabel}) ---`);
		lines.push(result.content);
	}
	lines.push('\nUse the above courseware fragments to ground your answer when relevant.');
	return lines.join('\n');
}
