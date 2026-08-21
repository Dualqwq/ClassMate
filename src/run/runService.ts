import * as path from 'path';
import * as vscode from 'vscode';
import { getCompileOutputContent } from '../compiler/outputPanel';
import { RunHistoryStore, truncateOutput } from '../storage/runHistoryStore';
import { discoverExecutable } from './executableDiscovery';
import { runExecutable } from './runner';
import { runInIntegratedTerminal } from './runTerminal';
import type {
	ExecutableSource,
	RunExtensionToWebviewMessage,
	RunPanelSnapshot,
	RunRecord,
	RunWebviewToExtensionMessage,
} from './types';

/**
 * Run 面板的 extension 侧编排(#11):exe 发现 → 运行 → 历史落盘 → 状态回推。
 * 只消费编译产物(compile_result.txt 内容 / 源文件路径推导),不做任何
 * 编译决策——compile 走 classmate.compile(轨 A 的 compilerService 链路)。
 */
export class RunService {
	private readonly _context: vscode.ExtensionContext;
	private readonly _store: RunHistoryStore;
	private _presenter: { postMessage(message: RunExtensionToWebviewMessage): void } | undefined;
	private _running = false;
	private _currentStartedAt: number | undefined;
	private _lastStdin = '';
	private _lastResult: RunRecord | undefined;
	private _interactiveHint: { exePath: string } | undefined;
	private _selectedExecutable: { path: string; source: ExecutableSource } | undefined;
	private _notice: string | undefined;

	constructor(context: vscode.ExtensionContext) {
		this._context = context;
		const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri.toString();
		this._store = new RunHistoryStore(context.globalStorageUri.fsPath, workspaceUri);
	}

	/** 面板 attach/detach;同一时刻至多一个 Run 面板。 */
	public attach(presenter: { postMessage(message: RunExtensionToWebviewMessage): void }): void {
		this._presenter = presenter;
		void this.pushState();
	}

	public detach(): void {
		this._presenter = undefined;
	}

	public async handleMessage(message: RunWebviewToExtensionMessage): Promise<void> {
		switch (message.type) {
			case 'run:requestState':
				await this.pushState();
				return;
			case 'run:start':
				await this.run(message.stdin);
				return;
			case 'run:pickExecutable':
				await this.pickExecutable();
				return;
			case 'run:openInTerminal':
				runInIntegratedTerminal(message.exePath);
				return;
			case 'run:dismissInteractiveHint':
				this._interactiveHint = undefined;
				await this.pushState();
				return;
		}
	}

	/**
	 * exe 发现(grill R2-Q1 分级链):make 回显 `-o` → 根目录最新 .exe →
	 * (make 场景)showOpenDialog → 兜底文案;g++ 场景由 active 源文件推导。
	 */
	public async resolveExecutable(options?: { allowDialog?: boolean }): Promise<RunPanelSnapshot['executable']> {
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!workspaceRoot) {
			this._notice = '请先打开一个工作区文件夹再运行。';
			return undefined;
		}
		const activeSource = vscode.window.activeTextEditor?.document.uri.scheme === 'file'
			? vscode.window.activeTextEditor.document.fileName
			: undefined;
		// make 场景消费编译回显(compile_result.txt,轨 A 产物);无回显时
		// parseMakeLinkTarget 拿不到目标,自然落到"最新 exe"兜底。
		// provider 未注册(极端时序)按无回显处理,不让发现流程抛错。
		let makeOutput = '';
		try {
			makeOutput = getCompileOutputContent();
		} catch {
			makeOutput = '';
		}
		const result = await discoverExecutable(workspaceRoot, activeSource, makeOutput || undefined);
		if (result.exePath && result.source) {
			this._notice = undefined;
			this._selectedExecutable = { path: result.exePath, source: result.source };
			return this._selectedExecutable;
		}
		if (result.makeScenario && options?.allowDialog) {
			const picked = await this.pickExecutable();
			if (picked) {
				return picked;
			}
		}
		this._notice = result.notice ?? '未能发现可执行文件,请先编译。';
		return undefined;
	}

	/** showOpenDialog 用户挑 exe(make 场景最后手段;面板按钮同入口)。 */
	public async pickExecutable(): Promise<RunPanelSnapshot['executable']> {
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		const picked = await vscode.window.showOpenDialog({
			title: '选择要运行的可执行文件',
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: false,
			defaultUri: workspaceRoot ? vscode.Uri.file(workspaceRoot) : undefined,
			filters: process.platform === 'win32' ? { '可执行文件': ['exe'] } : undefined,
		});
		if (!picked || picked.length === 0) {
			await this.pushState();
			return this._selectedExecutable;
		}
		this._selectedExecutable = { path: picked[0].fsPath, source: 'user-picked' };
		this._notice = undefined;
		await this.pushState();
		return this._selectedExecutable;
	}

	/** 运行主流程:发现 exe → 灌 stdin 运行 → 截断落历史 → 推状态。 */
	public async run(stdin: string): Promise<void> {
		if (this._running) {
			return;
		}
		this._lastStdin = stdin;
		this._interactiveHint = undefined;

		const executable = this._selectedExecutable ?? await this.resolveExecutable({ allowDialog: true });
		if (!executable) {
			// 兜底文案进面板,不弹窗打扰(拍板:无 exe 兜底文案)。
			this._lastResult = undefined;
			await this.pushState();
			return;
		}

		this._running = true;
		this._currentStartedAt = Date.now();
		this._lastResult = undefined;
		await this.pushState();

		let result: Awaited<ReturnType<typeof runExecutable>>;
		try {
			result = await runExecutable(executable.path, {
				stdin,
				cwd: path.dirname(executable.path),
				onOutput: (stream, text) => {
					this._presenter?.postMessage({ type: 'run:output', stream, text });
				},
			});
		} catch (error) {
			// spawn 失败(exe 被删/权限不足等):清掉选中,给出兜底文案。
			this._running = false;
			this._currentStartedAt = undefined;
			this._selectedExecutable = undefined;
			this._notice = `无法启动 ${executable.path}:${error instanceof Error ? error.message : String(error)}`;
			await this.pushState();
			return;
		}

		const stdout = truncateOutput(result.stdout);
		const stderr = truncateOutput(result.stderr);
		const record: RunRecord = {
			id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
			exePath: executable.path,
			startedAt: this._currentStartedAt,
			durationMs: result.durationMs,
			exitCode: result.exitCode,
			timedOut: result.timedOut,
			needsInteractiveInput: result.needsInteractiveInput,
			stdin,
			stdout: stdout.text,
			stderr: stderr.text,
			outputTruncated: stdout.truncated || stderr.truncated,
		};
		try {
			await this._store.append(record);
		} catch (error) {
			console.warn('[ClassMate] failed to persist run history', error);
		}

		this._running = false;
		this._currentStartedAt = undefined;
		this._lastResult = record;
		if (result.needsInteractiveInput) {
			this._interactiveHint = { exePath: executable.path };
		}
		await this.pushState();
	}

	/** 组装面板快照:当前选中 + 上次结果 + 按 exe 分组的历史(新的在前)。 */
	public async buildSnapshot(): Promise<RunPanelSnapshot> {
		const grouped = await this._store.readAll();
		return {
			executable: this._selectedExecutable,
			notice: this._notice,
			running: this._running,
			currentStartedAt: this._currentStartedAt,
			lastStdin: this._lastStdin,
			lastResult: this._lastResult,
			interactiveHint: this._interactiveHint,
			history: grouped
				.map((group) => ({
					exePath: group.exePath,
					records: [...group.records].reverse(),
				}))
				.sort((a, b) => (b.records[0]?.startedAt ?? 0) - (a.records[0]?.startedAt ?? 0)),
		};
	}

	public async pushState(): Promise<void> {
		if (!this._presenter) {
			return;
		}
		this._presenter.postMessage({ type: 'run:state', state: await this.buildSnapshot() });
	}
}
