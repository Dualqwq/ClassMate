import * as path from 'path';
import { readdir, stat } from 'fs/promises';

/**
 * exe 发现(#11,grill R2-Q1 拍板)。纯 Node 实现,不 import vscode,
 * 便于单测与仓库外 eval 脚本直接驱动。
 *
 * 分级链:
 * - make 场景(工作区根目录有 Makefile):解析 make 回显链接行 `-o <target>`
 *   为主 → 根目录最新 `.exe` 兜底 → 调用方再升级 showOpenDialog / 兜底文案。
 * - g++ 场景:沿用 resolveOutputPath 语义由 active 源文件推导。
 * 默认不跑指定 make target(尊重 Makefile 的默认目标)。
 */

const MAKEFILE_NAMES = new Set(['makefile', 'gnumakefile']);

/** 工作区根目录是否有 Makefile(只看根目录,与构建侧约定一致)。 */
export async function hasRootMakefile(workspaceRoot: string): Promise<boolean> {
	let entries;
	try {
		entries = await readdir(workspaceRoot, { withFileTypes: true });
	} catch {
		return false;
	}
	return entries.some(
		(entry) => entry.isFile() && MAKEFILE_NAMES.has(entry.name.toLowerCase())
	);
}

/**
 * 从 make 回显里解析链接产物:取全文中最后一个 `-o <target>`。
 * 链接行一般出现在回显末尾,取最后一次出现比逐行猜"哪行是链接"更稳。
 * 支持带引号目标(路径含空格);忽略紧随其后的另一选项(`-o -xxx` 视为无效)。
 */
export function parseMakeLinkTarget(makeOutput: string): string | undefined {
	const pattern = /(?:^|\s)-o\s+("([^"]+)"|'([^']+)'|(\S+))/g;
	let target: string | undefined;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(makeOutput)) !== null) {
		const candidate = match[2] ?? match[3] ?? match[4];
		if (candidate && !candidate.startsWith('-')) {
			target = candidate;
		}
	}
	return target;
}

/**
 * g++ 场景的输出路径推导,与 compilerService.resolveOutputPath 同语义
 * (Windows:<source>.exe;类 Unix:去掉扩展名)。本地重写以避免反向依赖
 * compiler 模块;compilerService 的实现若变化,这里应同步(见单测锚定)。
 */
export function resolveGppExecutablePath(sourcePath: string): string {
	const parsed = path.parse(sourcePath);
	if (process.platform === 'win32') {
		return path.join(parsed.dir, `${parsed.name}.exe`);
	}
	return path.join(parsed.dir, parsed.name);
}

const TEXT_LIKE_EXTENSIONS = new Set([
	'.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp', '.hxx',
	'.md', '.markdown', '.txt', '.in', '.out', '.ans', '.json', '.o', '.obj',
]);

/**
 * 工作区根目录最新的可执行文件(make 场景兜底)。只看根目录一层:
 * 与"根目录最新 .exe"的拍板一致,不递归子目录。
 * Windows 匹配 `.exe`;类 Unix 取有无扩展名且带可执行位的普通文件。
 */
export async function findNewestExecutable(workspaceRoot: string): Promise<string | undefined> {
	let entries;
	try {
		entries = await readdir(workspaceRoot, { withFileTypes: true });
	} catch {
		return undefined;
	}

	let newest: { path: string; mtimeMs: number } | undefined;
	for (const entry of entries) {
		if (!entry.isFile()) {
			continue;
		}
		const fullPath = path.join(workspaceRoot, entry.name);
		if (process.platform === 'win32') {
			if (!entry.name.toLowerCase().endsWith('.exe')) {
				continue;
			}
		} else {
			const ext = path.extname(entry.name).toLowerCase();
			if (ext && TEXT_LIKE_EXTENSIONS.has(ext)) {
				continue;
			}
			try {
				const info = await stat(fullPath);
				// 任一可执行位即视为可运行脚本/二进制。
				if ((info.mode & 0o111) === 0) {
					continue;
				}
			} catch {
				continue;
			}
		}
		try {
			const info = await stat(fullPath);
			if (!newest || info.mtimeMs > newest.mtimeMs) {
				newest = { path: fullPath, mtimeMs: info.mtimeMs };
			}
		} catch {
			// 文件可能在枚举与 stat 之间被删除,跳过。
		}
	}
	return newest?.path;
}

export interface ExecutableDiscoveryResult {
	exePath?: string;
	source?: 'make-echo' | 'latest-exe' | 'source-derived';
	/** 发现失败时的兜底文案(make 场景由调用方先升级 showOpenDialog)。 */
	notice?: string;
	/** 是否按 make 场景判定(根目录存在 Makefile)。 */
	makeScenario: boolean;
}

/**
 * 执行发现分级链(不含 showOpenDialog——涉及 UI,由 runService 补上)。
 *
 * @param workspaceRoot 工作区根目录(fsPath)
 * @param activeSourcePath 当前 active 源文件(g++ 场景用)
 * @param makeOutput make 场景的回显文本(compile_result.txt 内容)
 * @param fileExists 存在性检查(测试可注入)
 */
export async function discoverExecutable(
	workspaceRoot: string,
	activeSourcePath: string | undefined,
	makeOutput: string | undefined,
	fileExists: (candidate: string) => Promise<boolean> = defaultFileExists
): Promise<ExecutableDiscoveryResult> {
	if (await hasRootMakefile(workspaceRoot)) {
		// ① 解析 make 回显链接行 `-o <target>`。
		const target = makeOutput ? parseMakeLinkTarget(makeOutput) : undefined;
		if (target) {
			const candidate = path.isAbsolute(target) ? target : path.join(workspaceRoot, target);
			if (await fileExists(candidate)) {
				return { exePath: candidate, source: 'make-echo', makeScenario: true };
			}
		}
		// ② 根目录最新 .exe 兜底。
		const newest = await findNewestExecutable(workspaceRoot);
		if (newest) {
			return { exePath: newest, source: 'latest-exe', makeScenario: true };
		}
		// ③ 交给调用方:showOpenDialog → 兜底文案。
		return {
			makeScenario: true,
			notice: '未能从 Makefile 工程中发现可执行文件,请手动选择或先编译。',
		};
	}

	// g++ 场景:沿用 resolveOutputPath 语义。
	if (activeSourcePath) {
		const candidate = resolveGppExecutablePath(activeSourcePath);
		if (await fileExists(candidate)) {
			return { exePath: candidate, source: 'source-derived', makeScenario: false };
		}
	}
	return {
		makeScenario: false,
		notice: '尚未发现可执行文件,请先编译(ClassMate: Compile)。',
	};
}

async function defaultFileExists(candidate: string): Promise<boolean> {
	try {
		const info = await stat(candidate);
		return info.isFile();
	} catch {
		return false;
	}
}
