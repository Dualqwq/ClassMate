import type { DebugEvent } from './types';

export type FileExists = (fileUri: string) => Promise<boolean>;

/**
 * 过滤掉"文件已不存在"的事件,仅用于 Debug Journey 树的显示。
 *
 * store 里的原始隐式日志(events.jsonl)不会被改动;总结、错题本导出、
 * 知识卡等其他消费方仍然能看到完整历史。没有 fileUri 的事件
 * ("Other files" 组)始终保留。
 */
export async function filterEventsToExistingFiles(
	events: DebugEvent[],
	exists: FileExists
): Promise<DebugEvent[]> {
	const fileKeys = [
		...new Set(
			events
				.map((event) => event.fileUri)
				.filter((uri): uri is string => uri !== undefined)
		),
	];
	const verdicts = new Map<string, boolean>();
	await Promise.all(
		fileKeys.map(async (key) => {
			verdicts.set(key, await exists(key));
		})
	);
	return events.filter(
		(event) => event.fileUri === undefined || (verdicts.get(event.fileUri) ?? true)
	);
}
