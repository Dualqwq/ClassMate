import type { ParsedError } from '../error/errorParser';

/**
 * 划词解释的用户侧提示词(纯函数,与 webview/vscode 无依赖,便于单测)。
 *
 * 这些提示词会同时出现在三处:①经 startIntentResponse 成为聊天里学生可见
 * 的用户气泡文本;②hint_requested 事件的 userPrompt 落 DebugJourneyStore;
 * ③作为 userText 进入 answer prompt。读者是学生与 LLM 双方,故用自然中文
 * 表达而非机械英文条目。
 *
 * 原样保留的内容(中文化红线):报错原文(displayText/displayText 内的编译器
 * 输出)、文件路径、语言 tag、知识标签的 tag 标识符与其 message 文本、模板
 * 链摘要里的编译器原话(如 "required from here")。
 */

/**
 * 位置行:有模板归因帧时位置讲学生代码行,编译器最终报错(叶子)位置附注在
 * 后;无链时即诊断行自身位置;选区解析不出诊断时给明确兜底句。
 */
export function formatSelectionLocationLine(parsed: ParsedError | undefined): string {
	if (!parsed) {
		return '位置：无法解析';
	}
	const attributed = parsed.templateChain?.attributed;
	if (attributed) {
		return `位置：${attributed.file ?? '未知文件'}:${attributed.line ?? '?'}:${attributed.column ?? '?'}（根因在你写的这行代码里；报错叶子：${parsed.file ?? '未知文件'}:${parsed.line ?? '?'}）`;
	}
	return `位置：${parsed.file ?? '未知文件'}:${parsed.line ?? '?'}:${parsed.column ?? '?'}`;
}

/**
 * 知识点列表文本:一行一条「- tag: message」;没有命中时给中性兜底句,
 * 不静默留空(原英文 "No specific knowledge tag matched." 的等价表达)。
 */
export function formatSelectionKnowledgeText(
	entries: ReadonlyArray<{ tag: string; message: string }>
): string {
	if (entries.length === 0) {
		return '没有匹配到具体的知识点标签。';
	}
	return entries.map((k) => `- ${k.tag}: ${k.message}`).join('\n');
}

/**
 * 编译输出选区解释提示词。
 *
 * 语义约束与旧英文模板逐条对应:"in beginner-friendly language" → 初学者
 * 能听懂;Raw error 围栏块原样承载报错文本(围栏不带语言 tag,编译输出不是
 * 单一语言);模板链摘要行(有才附)与位置行沿用原顺序;知识点列表沿用
 * 「- tag: message」行格式。
 */
export function buildCompileErrorSelectionPrompt(parts: {
	displayText: string;
	templateSummary?: string;
	locationLine: string;
	knowledgeText: string;
}): string {
	return [
		'请用初学者能听懂的话，帮我讲解下面这个编译错误：',
		'',
		'原始报错：',
		'```',
		parts.displayText,
		'```',
		...(parts.templateSummary ? [parts.templateSummary, ''] : []),
		parts.locationLine,
		'',
		'已匹配到的知识点：',
		parts.knowledgeText,
	].join('\n');
}

/**
 * 源代码选区解释提示词。语言 tag 原样进围栏信息串(语法高亮与语义靠它)。
 */
export function buildCodeExplainPrompt(lang: string, text: string): string {
	return `请帮我讲解下面这段代码：\n\n\`\`\`${lang}\n${text}\n\`\`\``;
}
