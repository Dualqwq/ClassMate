import * as crypto from 'crypto';
import * as path from 'path';
import { mkdir, readFile, readdir, writeFile } from 'fs/promises';
import type { RunRecord } from '../run/types';

/**
 * ADD3 存储原语 + #11 运行历史(grill Q3 / R2-Q2 拍板)。
 * 纯 Node 实现(vscode 侧只负责把 globalStorageUri.fsPath 与
 * 工作区 Uri 字符串传进来),便于单测与仓库外 eval 脚本驱动。
 *
 * 布局:<globalStorage>/run-history/<hash(工作区 Uri)>/<hash(exe 绝对路径)>.jsonl
 * - 逐工作区目录,hash 输入 = 工作区 Uri(与 debug-journey 的
 *   getWorkspaceId 同法:sha256 前 16 hex,文件系统安全且稳定);
 * - 逐 exe 一条 JSONL 追加写;每个 exe 保留最近 20 次(环形);
 * - stdout/stderr 持久化按 64KB 头尾截断,中间插 "…N bytes 省略…" 标记;
 * - #14 错题本导出只留只读读接口(list / listExecutables / readAll),
 *   格式等 #14 立项再定。
 */

export const RUN_HISTORY_LIMIT = 20;
export const OUTPUT_PERSIST_LIMIT_BYTES = 64 * 1024;
const RUN_HISTORY_DIR = 'run-history';
const SINGLE_FILE_WORKSPACE = 'single-file';

/** 稳定、文件系统安全的短 hash(sha256 前 16 hex)。 */
export function hashStorageKey(input: string): string {
	return crypto.createHash('sha256').update(input).digest('hex').slice(0, 16);
}

/**
 * exe 路径归一化(仅用于落盘键,不改记录里的原始路径):
 * Windows 大小写不敏感、分隔符统一,避免同一 exe 拆成两条历史。
 */
export function normalizeExePathKey(exePath: string): string {
	const normalized = exePath.replace(/\\/g, '/');
	return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export interface TruncatedOutput {
	text: string;
	truncated: boolean;
	omittedBytes: number;
}

/**
 * 按 64KB 头尾截断(各留一半),中间插 "…N bytes 省略…" 标记。
 * 按码点推进、按 UTF-8 字节计量,不会在多字节字符中间劈开。
 */
export function truncateOutput(
	text: string,
	limitBytes: number = OUTPUT_PERSIST_LIMIT_BYTES
): TruncatedOutput {
	const totalBytes = Buffer.byteLength(text, 'utf8');
	if (totalBytes <= limitBytes) {
		return { text, truncated: false, omittedBytes: 0 };
	}
	const budget = Math.floor(limitBytes / 2);
	let headBytes = 0;
	let headEnd = 0;
	for (const ch of text) {
		const size = Buffer.byteLength(ch, 'utf8');
		if (headBytes + size > budget) {
			break;
		}
		headBytes += size;
		headEnd += ch.length;
	}
	let tailBytes = 0;
	let tailStart = text.length;
	for (let i = text.length - 1; i >= headEnd;) {
		const code = text.charCodeAt(i);
		// 低 surrogates 与前一个高 surrogate 同属一个码点。
		const width = code >= 0xdc00 && code <= 0xdfff && i - 1 >= headEnd ? 2 : 1;
		const ch = text.slice(i - width + 1, i + 1);
		const size = Buffer.byteLength(ch, 'utf8');
		if (tailBytes + size > budget) {
			break;
		}
		tailBytes += size;
		tailStart = i - width + 1;
		i -= width;
	}
	const omittedBytes = totalBytes - headBytes - tailBytes;
	const marker = `\n…${omittedBytes} bytes 省略…\n`;
	return {
		text: text.slice(0, headEnd) + marker + text.slice(tailStart),
		truncated: true,
		omittedBytes,
	};
}

function parseJsonl(text: string): RunRecord[] {
	const records: RunRecord[] = [];
	for (const line of text.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) {
			continue;
		}
		try {
			records.push(JSON.parse(trimmed) as RunRecord);
		} catch {
			// 容忍截断/损坏行(与 debugJourneyStore 同策略)。
		}
	}
	return records;
}

export class RunHistoryStore {
	private readonly _workspaceDir: string;

	/**
	 * @param globalStorageDir 扩展 globalStorageUri.fsPath(StorageUri 基座)
	 * @param workspaceUri 工作区 Uri 字符串(hash 输入);无工作区时用占位。
	 */
	constructor(globalStorageDir: string, workspaceUri: string | undefined) {
		const workspaceKey = workspaceUri ?? SINGLE_FILE_WORKSPACE;
		this._workspaceDir = path.join(
			globalStorageDir,
			RUN_HISTORY_DIR,
			hashStorageKey(workspaceKey)
		);
	}

	public get workspaceDir(): string {
		return this._workspaceDir;
	}

	private _fileFor(exePath: string): string {
		return path.join(this._workspaceDir, `${hashStorageKey(normalizeExePathKey(exePath))}.jsonl`);
	}

	/** 追加一次运行记录;超出每 exe 20 次环形上限时重写保留最新 20 条。 */
	public async append(record: RunRecord): Promise<void> {
		await mkdir(this._workspaceDir, { recursive: true });
		const file = this._fileFor(record.exePath);
		const existing = await this._readFile(file);
		const records = [...existing, record];
		const kept = records.length > RUN_HISTORY_LIMIT
			? records.slice(records.length - RUN_HISTORY_LIMIT)
			: records;
		const content = kept.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
		await writeFile(file, content, 'utf8');
	}

	/** 某 exe 的运行历史(按时间升序,新的在后)。 */
	public async list(exePath: string): Promise<RunRecord[]> {
		return this._readFile(this._fileFor(exePath));
	}

	/** 本工作区所有跑过的 exe 绝对路径(读接口,#14 预留)。 */
	public async listExecutables(): Promise<string[]> {
		let entries;
		try {
			entries = await readdir(this._workspaceDir, { withFileTypes: true });
		} catch {
			return [];
		}
		const executables: string[] = [];
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
				continue;
			}
			const records = await this._readFile(path.join(this._workspaceDir, entry.name));
			const first = records[0];
			if (first && !executables.includes(first.exePath)) {
				executables.push(first.exePath);
			}
		}
		return executables.sort((a, b) => a.localeCompare(b));
	}

	/** 全量只读导出(#14 预留):exe → 运行记录(时间升序)。 */
	public async readAll(): Promise<Array<{ exePath: string; records: RunRecord[] }>> {
		const executables = await this.listExecutables();
		const result: Array<{ exePath: string; records: RunRecord[] }> = [];
		for (const exePath of executables) {
			result.push({ exePath, records: await this.list(exePath) });
		}
		return result;
	}

	private async _readFile(file: string): Promise<RunRecord[]> {
		let text: string;
		try {
			text = await readFile(file, 'utf8');
		} catch {
			return [];
		}
		return parseJsonl(text);
	}
}
