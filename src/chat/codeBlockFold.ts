/**
 * 代码块折叠的确定性决策(纯函数,webview 的 CodeBlock 与单测共用)。
 *
 * 阈值取 >12 行默认折叠:课堂示例与报错片段通常在 10 行上下(头文件 + main +
 * 一段逻辑),12 行以内整块可读、无需折叠;超过 12 行多半是完整程序或长编译
 * 输出,默认折叠保持聊天流可读,需要时一键展开。折叠时先展示前 8 行:足够
 * 辨认"这是哪段代码"(一般已含函数签名与关键首行),其余行经按钮展开。
 *
 * 同一段代码永远得到同一个折叠计划(不依赖时间/流式状态),学生手动展开与
 * 收起由 CodeBlock 的局部 state 表达,不影响计划本身。
 */

/** 默认折叠的行数阈值:超过该行数的代码块折叠。 */
export const CODE_FOLD_COLLAPSE_THRESHOLD = 12;

/** 折叠态展示的前若干行数。 */
export const CODE_FOLD_PREVIEW_LINES = 8;

export interface CodeBlockFoldPlan {
	/** 去掉尾部换行后的总行数(「展开（N 行）」文案用)。 */
	totalLines: number;
	/** 是否默认折叠;仅由行数决定,保证同内容同渲染。 */
	shouldCollapse: boolean;
	/** 折叠态实际展示的文本(前 CODE_FOLD_PREVIEW_LINES 行);不折叠时即整段代码。 */
	previewText: string;
	/** 折叠时被隐藏的行数。 */
	hiddenLineCount: number;
}

export function planCodeBlockFold(code: string): CodeBlockFoldPlan {
	// CRLF 归一;剥掉尾部全部换行(ReactMarkdown 会把围栏结束前的最后一个
	// 换行留给 children,行数不应被它污染)。
	const normalized = code.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
	const lines = normalized.split('\n');
	const totalLines = lines.length;
	if (totalLines <= CODE_FOLD_COLLAPSE_THRESHOLD) {
		return { totalLines, shouldCollapse: false, previewText: normalized, hiddenLineCount: 0 };
	}
	const previewText = lines.slice(0, CODE_FOLD_PREVIEW_LINES).join('\n');
	return {
		totalLines,
		shouldCollapse: true,
		previewText,
		hiddenLineCount: totalLines - CODE_FOLD_PREVIEW_LINES,
	};
}
