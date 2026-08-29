/**
 * 用户消息的 markdown 展示预处理(纯函数,webview 与单测共用)。
 *
 * 背景:用户气泡从纯文本(pre-wrap 渲染)切到与助手一致的 MarkdownRenderer
 * 管线后,markdown 会把段落内的单个换行合并成空格——而学生手打的换行几乎
 * 都是"我想在这里换行"。本函数把围栏代码块**之外**的软换行升级为 markdown
 * 硬换行(行尾补两个空格),视觉上与旧的 pre-wrap 行为一致。
 *
 * 红线:
 * - 只改展示层传入 MarkdownRenderer 的文本,**绝不改写消息本身**
 *   (ChatState/会话存储/IME 提交的原文不受影响)。
 * - 围栏代码块(``` / ~~~)内的换行原样保留,补空格会污染代码内容。
 * - 已是硬换行的行尾(两个以上空格、反斜杠)不再重复补。
 */

/** 判定一行是否为围栏开/闭行:最多 3 个前导空格 + 3 个以上 ` 或 ~。 */
function matchFenceLine(line: string): RegExpMatchArray | null {
	return /^ {0,3}(`{3,}|~{3,})/.exec(line);
}

export function prepareUserMarkdown(content: string): string {
	// 单行快路径:绝大多数聊天消息没有换行,零改动返回。
	if (!content.includes('\n')) {
		return content;
	}
	const lines = content.replace(/\r\n?/g, '\n').split('\n');
	// 当前所处围栏的标记串(如 '```');null = 不在围栏内。
	// 闭围栏须同字符且长度不小于开围栏(CommonMark 规则的简化实现)。
	let fence: string | null = null;
	for (let i = 0; i < lines.length - 1; i++) {
		const line = lines[i];
		const fenceMatch = matchFenceLine(line);
		if (fence !== null) {
			// 围栏内:所有换行(含空行)原样保留;遇到匹配的闭围栏才退出。
			if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) {
				fence = null;
			}
			continue;
		}
		if (fenceMatch) {
			// 围栏开/闭行自身的换行是块结构,不补空格。
			fence = fenceMatch[1];
			continue;
		}
		// 围栏外:两行都非空的单换行 = 学生想要的换行 → 补两个空格成硬换行。
		if (
			line.trim() !== ''
			&& lines[i + 1].trim() !== ''
			&& !/ {2,}$/.test(line)
			&& !/\\$/.test(line)
		) {
			lines[i] = `${line}  `;
		}
	}
	return lines.join('\n');
}
