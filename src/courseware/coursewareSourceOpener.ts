import * as vscode from 'vscode';
import { spawn } from 'child_process';
import type { CoursewareGraph, CoursewareItem } from './types';

/**
 * 溯源打开（期 1.5）：按 chunkId 定位原始课件文件并用系统默认程序打开。
 * - 定位链：graph.nodes(chunkId→sourceId) → 导入列表(sourceId→item.uri 绝对路径)；
 *   item.uri 在导入时即持久化为绝对文件 URI，无需补字段；
 * - 打开方式：本地文件按 fsPath 用系统原生方式直开（Windows 走
 *   rundll32 url.dll,FileProtocolHandler，macOS/Linux 走 open/xdg-open），
 *   页号只在链接文本展示，深度跳页参数（如 Acrobat page=N）跨查看器不可移植，v1 不做；
 * - 目标文件被移动/删除时返回明确结果由调用方提示，绝不静默失败。
 *
 * 为什么不走 vscode.env.openExternal(Uri)：
 * 实测（Win32 ShellExecuteEx, SEE_MASK_FLAG_NO_UI）env.openExternal 传入的 file:// URI
 * 以百分号编码字符串原样交给 ShellExecute，后者不解码——路径含中文/空格（乃至盘符 %3A）
 * 必报「系统找不到指定的文件」0x2；而 workspace.fs.stat 正确解码所以存在性检查反而能过。
 * 原生路径直开同机实测可正常拉起默认程序。
 */

export type CoursewareSourceOpenOutcome = 'opened' | 'missing-file' | 'unknown-chunk';

/** 打开溯源所需的只读视图：CoursewareService 即满足该形状。 */
export interface CoursewareSourceLookup {
	getItem(id: string): CoursewareItem | undefined;
	loadGraph(): Promise<CoursewareGraph>;
}

/** 可注入的外部效应（默认走真实系统能力），单测用假实现锁定行为。 */
export interface CoursewareSourceOpenDeps {
	openFile(fsPath: string): Thenable<unknown>;
	stat(uri: vscode.Uri): Thenable<unknown>;
}

/**
 * 解析导入条目持久化的源文件引用。导入时存的是 uri.toString()（file:// 字符串），
 * 用 Uri.parse；兼容旧数据可能存的纯绝对路径，用 Uri.file 归一化。
 * 判据：带 `scheme://` 前缀的按 URI 解析，否则按文件系统路径处理
 * （单字母盘符 `d:\...` 不带 `//`，不会被误判成 scheme）。
 */
export function parseStoredSourceRef(raw: string): vscode.Uri {
	const trimmed = raw.trim();
	return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)
		? vscode.Uri.parse(trimmed)
		: vscode.Uri.file(trimmed);
}

function defaultDeps(): CoursewareSourceOpenDeps {
	return {
		stat: (uri) => vscode.workspace.fs.stat(uri),
		openFile: (fsPath) => openWithSystemDefault(fsPath),
	};
}

/** 按平台用系统默认程序打开本地文件路径；失败返回 false 由上层兜底提示。 */
function openWithSystemDefault(fsPath: string): Promise<boolean> {
	return new Promise((resolve) => {
		try {
			let command: string;
			let args: string[];
			if (process.platform === 'win32') {
				command = 'rundll32';
				args = ['url.dll,FileProtocolHandler', fsPath];
			} else if (process.platform === 'darwin') {
				command = 'open';
				args = [fsPath];
			} else {
				command = 'xdg-open';
				args = [fsPath];
			}
			const child = spawn(command, args, { detached: true, stdio: 'ignore' });
			child.on('error', () => resolve(false));
			child.unref();
			resolve(true);
		} catch {
			resolve(false);
		}
	});
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
		console.log(`[ClassMate][courseware-open] missing-file: ${resolved.uri.toString()}`);
		return 'missing-file';
	}
	await deps.openFile(resolved.uri.fsPath);
	console.log(
		`[ClassMate][courseware-open] raw=${JSON.stringify(resolved.raw)} uri=${resolved.uri.toString()} fsPath=${resolved.uri.fsPath}`
	);
	return 'opened';
}

/**
 * 解析 chunkId 对应的源文件 URI。找不到节点或导入条目时返回 undefined
 * （删除课件只移出列表、图保留旧节点，因此「有节点无条目」是常态而非异常）。
 */
export async function resolveChunkSourceUri(
	lookup: CoursewareSourceLookup,
	chunkId: string
): Promise<{ uri: vscode.Uri; fileName: string; raw: string } | undefined> {
	const graph = await lookup.loadGraph();
	const node = graph.nodes.find((candidate) => candidate.chunkId === chunkId);
	if (!node) {
		return undefined;
	}
	const item = lookup.getItem(node.sourceId);
	if (!item) {
		return undefined;
	}
	return { uri: parseStoredSourceRef(item.uri), fileName: item.fileName, raw: item.uri };
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
