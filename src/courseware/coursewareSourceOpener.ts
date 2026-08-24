import * as vscode from 'vscode';
import type { CoursewareGraph, CoursewareItem } from './types';

/**
 * 溯源打开（期 1.5）：按 chunkId 定位原始课件文件并用系统默认程序打开。
 * - 定位链：graph.nodes(chunkId→sourceId) → 导入列表(sourceId→item.uri 绝对路径)；
 *   item.uri 在导入时即持久化为绝对文件 URI，无需补字段；
 * - 打开方式统一走 vscode.env.openExternal(Uri.file(...))，页号只在链接文本展示，
 *   深度跳页参数（如 Acrobat page=N）跨查看器不可移植，v1 不做；
 * - 目标文件被移动/删除时返回明确结果由调用方提示，绝不静默失败。
 */

export type CoursewareSourceOpenOutcome = 'opened' | 'missing-file' | 'unknown-chunk';

/** 打开溯源所需的只读视图：CoursewareService 即满足该形状。 */
export interface CoursewareSourceLookup {
	getItem(id: string): CoursewareItem | undefined;
	loadGraph(): Promise<CoursewareGraph>;
}

/** 可注入的外部效应（默认走真实 VS Code API），单测用假实现锁定行为。 */
export interface CoursewareSourceOpenDeps {
	openExternal(uri: vscode.Uri): Thenable<boolean>;
	stat(uri: vscode.Uri): Thenable<unknown>;
}

function defaultDeps(): CoursewareSourceOpenDeps {
	return {
		openExternal: (uri) => vscode.env.openExternal(uri),
		stat: (uri) => vscode.workspace.fs.stat(uri),
	};
}

/**
 * 解析 chunkId 对应的源文件 URI。找不到节点或导入条目时返回 undefined
 * （删除课件只移出列表、图保留旧节点，因此「有节点无条目」是常态而非异常）。
 */
export async function resolveChunkSourceUri(
	lookup: CoursewareSourceLookup,
	chunkId: string
): Promise<{ uri: vscode.Uri; fileName: string } | undefined> {
	const graph = await lookup.loadGraph();
	const node = graph.nodes.find((candidate) => candidate.chunkId === chunkId);
	if (!node) {
		return undefined;
	}
	const item = lookup.getItem(node.sourceId);
	if (!item) {
		return undefined;
	}
	return { uri: vscode.Uri.parse(item.uri), fileName: item.fileName };
}

/**
 * 打开 chunk 所属课件源文件；外部效应可注入以便单测。
 * 返回结果语义：
 * - opened：文件存在且已交给系统默认程序；
 * - missing-file：导入条目在但文件已被移动/删除；
 * - unknown-chunk：chunkId 无法定位到导入条目（图待重建或课件已移除）。
 */
export async function openCoursewareChunkSource(
	lookup: CoursewareSourceLookup,
	chunkId: string,
	deps: CoursewareSourceOpenDeps = defaultDeps()
): Promise<CoursewareSourceOpenOutcome> {
	const resolved = await resolveChunkSourceUri(lookup, chunkId);
	if (!resolved) {
		return 'unknown-chunk';
	}
	try {
		await deps.stat(resolved.uri);
	} catch {
		return 'missing-file';
	}
	await deps.openExternal(resolved.uri);
	return 'opened';
}

/**
 * 统一的非成功提示：管理页与 chat 两条链路共用同一文案，缺文件/未知片段
 * 都给出明确信息，不静默失败。
 */
export function showCoursewareSourceOutcome(outcome: CoursewareSourceOpenOutcome): void {
	if (outcome === 'missing-file') {
		void vscode.window.showInformationMessage(
			'课件文件已被移动或删除，无法打开原始文件。可在课件管理页移除该课件后重新导入。'
		);
	} else if (outcome === 'unknown-chunk') {
		void vscode.window.showInformationMessage(
			'未找到该片段对应的课件，它可能已从导入列表移除，或搜索图需要重建。'
		);
	}
}
