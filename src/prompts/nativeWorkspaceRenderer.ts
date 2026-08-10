import * as path from 'path';
import type {
	WorkspaceCatalog,
	WorkspaceFileKind,
} from '../workspace/types';

export interface NativeFileEntry {
	path: string;
	kind: WorkspaceFileKind;
	content: string;
	contentHash?: string;
	reason?: string;
}

export interface UnloadedBoundaryEntry {
	path: string;
	kind: WorkspaceFileKind;
	size: number;
}

export interface UnloadedBoundary {
	unloaded: UnloadedBoundaryEntry[];
	omittedCount: number;
}

const MAX_UNLOADED_LIST_ENTRIES = 100;
const FENCE_CANDIDATES = ['```', '~~~', '````', '`````'] as const;
const BOUNDARY_EXCLUDED_BASENAMES = new Set(['classmate.md']);

function comparablePath(value: string): string {
	return value.replace(/\\/g, '/').toLocaleLowerCase();
}

/**
 * 统一 CRLF/CR 为 LF。行号按归一化后的 1 基行计数，
 * 与 answerReferenceSanitizer 对 raw content 的 split('\n') 行号口径一致。
 */
export function normalizeLineEndings(content: string): string {
	return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * 从固定候选里选一个正文中不出现的 fence；
 * 候选全被占用时退回比正文最长连续反引号串更长的反引号串，保证永不截断。
 */
export function pickFence(content: string): string {
	for (const candidate of FENCE_CANDIDATES) {
		if (!content.includes(candidate)) {
			return candidate;
		}
	}
	let longestRun = 0;
	let currentRun = 0;
	for (const char of content) {
		if (char === '`') {
			currentRun += 1;
			longestRun = Math.max(longestRun, currentRun);
		} else {
			currentRun = 0;
		}
	}
	return '`'.repeat(Math.max(3, longestRun + 1));
}

/** 把正文渲染成 1 基编号行；空文件不产生行。 */
export function numberedLines(content: string): string[] {
	const normalized = normalizeLineEndings(content);
	if (normalized === '') {
		return [];
	}
	return normalized.split('\n').map((line, index) =>
		`${String(index + 1).padStart(4, ' ')} | ${line}`);
}

/**
 * 渲染单个文件：一行元数据 JSON（path/kind 在前、contentHash 其次、
 * reason 最后——reason 来自路由请求每轮可能变化，放末尾不截断稳定前缀）
 * + 带行号的代码块。空文件给显式标记。
 */
export function renderNativeFileBlock(file: NativeFileEntry): string {
	const metadata = JSON.stringify({
		path: file.path,
		kind: file.kind,
		...(file.contentHash !== undefined ? { contentHash: file.contentHash } : {}),
		...(file.reason !== undefined ? { reason: file.reason } : {}),
	});
	const fence = pickFence(file.content);
	const body = file.content === ''
		? '[empty file]'
		: numberedLines(file.content).join('\n');
	return [metadata, fence, body, fence].join('\n');
}

/**
 * 未加载边界：catalog 中存在、但未进入 loadedItems 的文件元数据清单。
 * 与 manifest 一样按路径排序、限制展示条数，超出部分用 omittedCount 表达，
 * 避免大工作区把“未加载清单”本身变成新的上下文淹没源。
 * CLASSMATE.md 由课程上下文单独注入，不在加载范围，也不进边界清单。
 */
export function buildUnloadedBoundary(
	catalog: WorkspaceCatalog,
	loadedItems: ReadonlyArray<{ path: string }>
): UnloadedBoundary {
	const loadedPaths = new Set(loadedItems.map((item) => comparablePath(item.path)));
	const candidates = catalog.files
		.filter((entry) =>
			!loadedPaths.has(comparablePath(entry.path))
			&& !BOUNDARY_EXCLUDED_BASENAMES.has(path.basename(entry.path).toLocaleLowerCase())
		)
		.sort((left, right) => left.path.localeCompare(right.path))
		.map((entry) => ({ path: entry.path, kind: entry.kind, size: entry.size }));
	return {
		unloaded: candidates.slice(0, MAX_UNLOADED_LIST_ENTRIES),
		omittedCount: Math.max(0, candidates.length - MAX_UNLOADED_LIST_ENTRIES),
	};
}
