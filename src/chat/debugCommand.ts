export interface ParsedDebugCommand {
	command: string;
	filePath?: string;
}

/**
 * 解析调试命令,支持两种形式:
 * - `//show-ref`              -> 输出到聊天
 * - `//show-ref <文件路径>`   -> 输出到文件
 * 返回 undefined 表示这不是一条调试命令。
 */
export function parseDebugCommand(text: string): ParsedDebugCommand | undefined {
	const trimmed = text.trim();
	const match = /^\/\/([a-zA-Z0-9_-]+)(?:\s+(.*))?$/.exec(trimmed);
	if (!match) {
		return undefined;
	}
	const filePath = match[2]?.trim();
	return filePath
		? { command: match[1], filePath }
		: { command: match[1] };
}
