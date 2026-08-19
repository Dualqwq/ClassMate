import {
	buildCppWorkspaceIndex,
	type CppWorkspaceIndex,
} from '../parser/cppWorkspaceIndex';

/**
 * 大工作区的文件/符号结构图:只含路径与符号签名,不含正文。
 * 用于"哪些文件有哪些符号"的导航与引用消歧,正文仍按需加载。
 */
export interface WorkspaceStructureFile {
	path: string;
	symbols: Array<{
		name: string;
		kind: string;
		container?: string;
		startLine: number;
		endLine: number;
	}>;
}

/** 解析成本随文件数线性增长;结构图本身只需覆盖可导航的头部文件集。 */
const MAX_STRUCTURE_FILES = 80;

export async function buildWorkspaceStructureMap(
	files: Array<{ path: string; kind: string; content: string }>,
	indexBuilder: typeof buildCppWorkspaceIndex = buildCppWorkspaceIndex
): Promise<WorkspaceStructureFile[]> {
	const codeFiles = files
		.filter((file) => file.kind === 'code')
		.slice(0, MAX_STRUCTURE_FILES);
	if (codeFiles.length === 0) {
		return [];
	}
	// buildCppWorkspaceIndex 内部按文件逐个降级;这里不因个别坏文件失败。
	const index: CppWorkspaceIndex = await indexBuilder(
		codeFiles.map((file) => ({ path: file.path, content: file.content }))
	);
	return index.symbols.length === 0 && index.degradedFiles.length > 0
		? []
		: index.symbols.reduce<WorkspaceStructureFile[]>((result, symbol) => {
			let bucket = result.find((entry) => entry.path === symbol.file);
			if (!bucket) {
				bucket = { path: symbol.file, symbols: [] };
				result.push(bucket);
			}
			bucket.symbols.push({
				name: symbol.name,
				kind: symbol.kind,
				container: symbol.container,
				startLine: symbol.startLine,
				endLine: symbol.endLine,
			});
			return result;
		}, []).sort((left, right) => left.path.localeCompare(right.path));
}
