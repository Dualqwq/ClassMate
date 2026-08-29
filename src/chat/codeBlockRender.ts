/**
 * markdown `<code>` 节点的块级/行内渲染判定。
 *
 * 背景(2026-08-28 返工):react-markdown v9 只在围栏块带语言标注时才给
 * `<code>` 加 `language-xxx` class;无语言标注的围栏块与缩进代码块拿不到
 * 任何 class。此前 MarkdownRenderer 用「没有 className = 行内代码」判定,
 * 把无标注围栏块误判成行内 `.code-chip`(inline 元素带背景),多行文本
 * 逐行盒各画一份背景+4px 小圆角,出现"坑坑洼洼/半角圆角"。
 *
 * 修正后的判定:有 className 或文本含换行,一律按块级代码块渲染。
 * 行内 code span 几乎从不含换行;跨行行内 code 被按块渲染是安全的
 * 误判方向——仍是等宽整块矩形,不会碎成逐行小背景。
 * 该判定供两种气泡共用的 MarkdownRenderer 单源调用,勿在别处分叉。
 */
export function isBlockLevelCode(
	className: string | undefined,
	text: string | undefined
): boolean {
	if (className) {
		return true;
	}
	return typeof text === 'string' && text.includes('\n');
}
