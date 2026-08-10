import * as path from 'path';

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

/**
 * 解析调试输出文件的磁盘路径:
 * - 绝对路径原样返回;
 * - 相对路径默认落到 `debugOutputDir`(固定为项目根下的 log 目录,不随工作区变化);
 *   未配置时回退到 `<工作区根>/log`,再退到活动文件目录 / cwd。
 * log 目录会从工作区上下文中排除,避免调试 dump 被当成作业文件回灌。
 */
export function resolveDebugOutputPath(
	filePath: string,
	options: { debugOutputDir?: string; workspaceRoot?: string; activeFileDir?: string; cwd: string }
): string {
	const trimmed = filePath.trim();
	const isAbsolute =
		/^[a-zA-Z]:[\\/]/.test(trimmed) ||
		trimmed.startsWith('/') ||
		trimmed.startsWith('\\');
	if (isAbsolute) {
		return trimmed;
	}
	const base = options.debugOutputDir
		?? path.join(options.workspaceRoot ?? options.activeFileDir ?? options.cwd, 'log');
	return path.join(base, trimmed);
}
