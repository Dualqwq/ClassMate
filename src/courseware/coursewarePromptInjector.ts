import type { CoursewareRetrievalResult } from './types';

/**
 * 注入层（期 2 D8）：把检索结果格式化为模型可见的上下文块。
 * - 每片段带定位头 `--- 《文件名》 标题 · slide N/p.N ---`，页号真实可溯源；
 * - 总预算 4000 字符：超限先丢低分整片，最后一片在剩余预算内截断；
 * - 空命中返回 ''，不注入占位块（answer prompt 的固定标题块由
 *   answerPromptBuilder 负责，占位文案不进课件上下文本体）。
 */

export const COURSEWARE_CONTEXT_TOTAL_BUDGET = 4000;

/** 截断后至少保留的片段字符数；剩余预算不足此值时整片丢弃。 */
const MIN_FRAGMENT_CHARS = 200;

const HEADER = '=== Courseware context (from imported slides/notes) ===';
const FOOTER = '\nUse the above courseware fragments to ground your answer when relevant.';

/** 定位头：`《文件名》 标题 · slide N/p.N`（页号只在文本展示，深度跳页 v1 不做）。 */
export function formatFragmentLocator(result: CoursewareRetrievalResult): string {
	const parts: string[] = [`《${result.fileName}》`];
	if (result.title) {
		parts.push(result.title);
	}
	parts.push(result.unitLabel ?? formatPageLabel(result));
	return parts.join(' · ');
}

function formatPageLabel(result: CoursewareRetrievalResult): string {
	return result.pageStart === result.pageEnd
		? `p.${result.pageStart}`
		: `p.${result.pageStart}-${result.pageEnd}`;
}

/**
 * 按预算组装上下文块。结果应已按分数降序传入（retrieve 的输出序）：
 * - 高分片段优先整体纳入；
 * - 剩余预算装不下时，该低分片段整片丢弃（后续更低分者若更小仍可回填）；
 * - 仅当单个片段自身超过总预算时做单片截断。
 */
export function formatCoursewareContext(results: CoursewareRetrievalResult[]): string {
	if (results.length === 0) {
		return '';
	}
	let budget = COURSEWARE_CONTEXT_TOTAL_BUDGET - HEADER.length - FOOTER.length;
	const blocks: string[] = [];
	for (const result of results) {
		const head = `\n--- ${formatFragmentLocator(result)} ---\n`;
		if (head.length + result.content.length <= budget) {
			budget -= head.length + result.content.length;
			blocks.push(`${head}${result.content}`);
			continue;
		}
		if (result.content.length > COURSEWARE_CONTEXT_TOTAL_BUDGET - HEADER.length - FOOTER.length) {
			// 单片自身超预算：截断进剩余空间
			const content = result.content.slice(0, Math.max(0, budget - head.length)).trimEnd();
			if (content.length >= MIN_FRAGMENT_CHARS) {
				budget -= head.length + content.length;
				blocks.push(`${head}${content}`);
			}
			continue;
		}
		// 低分整片丢弃：不再消耗预算
	}
	if (blocks.length === 0) {
		return '';
	}
	return [HEADER, ...blocks, FOOTER].join('');
}
