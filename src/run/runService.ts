import * as path from 'path';
import * as vscode from 'vscode';
import { getCompileOutputContent } from '../compiler/outputPanel';
import { deriveProblemKeyFromMaterial } from '../debug/problemMaterial';
import type { DebugJourneyStore } from '../debug/debugJourneyStore';
import type { RunErrorEvent, RunSuccessEvent } from '../debug/types';
import { RunHistoryStore, truncateOutput } from '../storage/runHistoryStore';
import { discoverExecutable, findSourceFileForExecutable } from './executableDiscovery';
import { checkExecutableAvailability } from './executableAvailability';
import { runExecutable } from './runner';
import { runInIntegratedTerminal } from './runTerminal';
import { classifyRunError } from './runErrorClassifier';
import type {
	ExecutableAvailability,
	ExecutableSource,
	RunExtensionToWebviewMessage,
	RunPanelSnapshot,
	RunRecord,
	RunWebviewToExtensionMessage,
} from './types';

/** 面板状态维护间隔：未选择时发现，已选择时检查原路径。 */
const AUTO_DISCOVER_INTERVAL_MS = 2000;

/**
 * Run 面板的 extension 侧编排(#11):exe 发现 → 运行 → 历史落盘 → 状态回推。
 * 只消费编译产物(compile_result.txt 内容 / 源文件路径推导),不做任何
 * 编译决策——compile 走 classmate.compile(轨 A 的 compilerService 链路)。
 */
export class RunService {
	private readonly _context: vscode.ExtensionContext;
	private readonly _store: RunHistoryStore;
	private readonly _debugStore?: DebugJourneyStore;
	private readonly _sessionId?: string;
	private _presenter: { postMessage(message: RunExtensionToWebviewMessage): void } | undefined;
	private _running = false;
	private _currentStartedAt: number | undefined;
	private _lastStdin = '';
	private _lastResult: RunRecord | undefined;
	private _interactiveHint: { exePath: string } | undefined;
	/**
	 * 当前选中的 exe 与其源文件归位信息:sourcePath 只在 g++ 场景
	 * (source-derived,exe 由该源文件推导)有值;其余发现来源在写事件时
	 * 走同目录 stem 匹配兜底。sourcePath 不进面板快照(webview 契约不变)。
	 */
	private _selectedExecutable: { path: string; source: ExecutableSource; sourcePath?: string; availability: ExecutableAvailability } | undefined;
	private _notice: string | undefined;
	private _discoverInterval: ReturnType<typeof setInterval> | undefined;

	private readonly _checkExecutable: typeof checkExecutableAvailability;
	private _availabilityCheck?: { selection: NonNullable<RunService['_selectedExecutable']>; promise: Promise<boolean> };
	private _maintenanceInFlight = false;
	private _selectionRevision = 0;
	private _lifecycleRevision = 0;
	private _pushRevision = 0;

	constructor(
		context: vscode.ExtensionContext,
		options?: { debugStore?: DebugJourneyStore; sessionId?: string; checkExecutable?: typeof checkExecutableAvailability }
	) {
		this._context = context;
		this._debugStore = options?.debugStore;
		this._sessionId = options?.sessionId;
		this._checkExecutable = options?.checkExecutable ?? checkExecutableAvailability;
		const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri.toString();
		this._store = new RunHistoryStore(context.globalStorageUri.fsPath, workspaceUri);
	}

	/** 面板 attach/detach;同一时刻至多一个 Run 面板。 */
	public attach(presenter: { postMessage(message: RunExtensionToWebviewMessage): void }): void {
		this._lifecycleRevision++;
		this._presenter = presenter;
		void this.pushState();
		this._startAutoDiscover();
	}

	public detach(): void {
		this._lifecycleRevision++;
		this._pushRevision++;
		this._presenter = undefined;
		this._stopAutoDiscover();
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
		const revision = this._selectionRevision;
		const lifecycle = this._lifecycleRevision;
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
		if (revision !== this._selectionRevision || lifecycle !== this._lifecycleRevision) {
			return this._selectedExecutable;
		}
		if (result.exePath && result.source) {
			this._selectionRevision++;
			this._notice = undefined;
			this._selectedExecutable = {
				path: result.exePath,
				source: result.source,
				availability: 'unknown',
				// g++ 场景:exe 由该源文件推导,归位所需的映射在这里捕获。
				...(result.source === 'source-derived' && activeSource
					? { sourcePath: activeSource }
					: {}),
			};
			await this._refreshAvailability();
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
		if (this._running) { return this._selectedExecutable; }
		const revision = ++this._selectionRevision;
		const lifecycle = this._lifecycleRevision;
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		const picked = await vscode.window.showOpenDialog({
			title: '选择要运行的可执行文件',
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: false,
			defaultUri: workspaceRoot ? vscode.Uri.file(workspaceRoot) : undefined,
			filters: process.platform === 'win32' ? { '可执行文件': ['exe'] } : undefined,
		});
		if (this._running || revision !== this._selectionRevision || lifecycle !== this._lifecycleRevision) {
			return this._selectedExecutable;
		}
		if (!picked || picked.length === 0) {
			await this.pushState();
			return this._selectedExecutable;
		}
		this._selectedExecutable = { path: picked[0].fsPath, source: 'user-picked', availability: 'unknown' };
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

		// 运行前再次检查，保留用户选择；维护周期不能代替这道竞态守卫。
		await this._refreshAvailability();
		if (executable !== this._selectedExecutable || this._running) { return; }
		if (executable.availability === 'missing') {
			this._notice = undefined;
			this._lastResult = undefined;
			await this.pushState();
			return;
		}

		this._notice = undefined;
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
			// spawn 失败后复检：权限/格式错误不等于文件消失，保留选择。
			this._running = false;
			this._currentStartedAt = undefined;
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

		await this._recordRunOutcome(record);

		this._running = false;
		this._currentStartedAt = undefined;
		this._lastResult = record;
		if (result.needsInteractiveInput) {
			this._interactiveHint = { exePath: executable.path };
		}
		await this.pushState();
	}

	/**
	 * 把运行结果写入 DebugJourneyStore，供 Journey 面板时间线展示。
	 * 未注入 debugStore 时（单测场景）直接跳过，不影响 Run 面板本身行为。
	 */
	private async _recordRunOutcome(record: RunRecord): Promise<void> {
		if (!this._debugStore) {
			return;
		}
		const event = buildRunOutcomeEvent(
			record,
			{
				sessionId: this._sessionId ?? 'unknown',
				workspaceId: this._debugStore.workspaceId,
			},
			await this._resolveRunAttribution(record)
		);
		try {
			await this._debugStore.append(event);
		} catch (error) {
			console.warn('[ClassMate] failed to append run outcome to debug journey', error);
		}
	}

	/**
	 * 运行事件的归属信息(FE3 遗留 ①②):exe → 源文件 URI + 题目材料键。
	 * source-derived 场景用发现时捕获的源文件;其余发现来源退同目录同 stem
	 * 匹配;题目材料只认源文件(或 exe)所在目录的 question.md/PDF 标题。
	 * 任何失败都回退「无归位字段」——运行结果本身必须照常写入 Journey,
	 * 消费侧再回退 exe 路径与文件名 stem(现状行为)。
	 */
	private async _resolveRunAttribution(
		record: RunRecord
	): Promise<{ sourceFileUri?: string; problemKey?: string }> {
		try {
			const sourcePath = this._selectedExecutable?.sourcePath
				?? await findSourceFileForExecutable(record.exePath);
			const anchorUri = vscode.Uri.file(sourcePath ?? record.exePath);
			const problemKey = await deriveProblemKeyFromMaterial(anchorUri);
			return {
				...(sourcePath ? { sourceFileUri: anchorUri.toString() } : {}),
				...(problemKey !== undefined ? { problemKey } : {}),
			};
		} catch {
			return {};
		}
	}

	/** 组装面板快照:当前选中 + 上次结果 + 按 exe 分组的历史(新的在前)。 */
	public async buildSnapshot(): Promise<RunPanelSnapshot> {
		const grouped = await this._store.readAll();
		await this._refreshAvailability();
		return {
			executable: this._selectedExecutable
				? {
					path: this._selectedExecutable.path,
					source: this._selectedExecutable.source,
					availability: this._selectedExecutable.availability,
				}
				: undefined,
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
		const presenter = this._presenter;
		const revision = ++this._pushRevision;
		const state = await this.buildSnapshot();
		// 慢磁盘读取/旧面板的异步快照不能覆盖较新的广播。
		if (revision === this._pushRevision && presenter === this._presenter) {
			presenter.postMessage({ type: 'run:state', state });
		}
	}

	/** 同一个选择只允许一个 stat 在途，慢检查不得把旧路径状态写到新选择。 */
	private async _refreshAvailability(): Promise<boolean> {
		const selection = this._selectedExecutable;
		if (!selection || this._running) { return false; }
		if (this._availabilityCheck?.selection === selection) {
			return this._availabilityCheck.promise;
		}
		const promise = (async () => {
			const availability = await this._checkExecutable(selection.path);
			if (selection !== this._selectedExecutable || this._running) { return false; }
			const changed = selection.availability !== availability;
			selection.availability = availability;
			return changed;
		})();
		const check = { selection, promise };
		this._availabilityCheck = check;
		try {
			return await promise;
		} finally {
			if (this._availabilityCheck === check) { this._availabilityCheck = undefined; }
		}
	}

	/** 面板挂载期间维护原路径；只有未选路径才做自动发现。 */
	private _startAutoDiscover(): void {
		this._stopAutoDiscover();
		if (!this._presenter) { return; }
		if (!this._selectedExecutable) { void this._autoDiscoverTick(); }
		this._discoverInterval = setInterval(() => void this._autoDiscoverTick(), AUTO_DISCOVER_INTERVAL_MS);
	}

	private _stopAutoDiscover(): void {
		if (this._discoverInterval) {
			clearInterval(this._discoverInterval);
			this._discoverInterval = undefined;
		}
	}

	private async _autoDiscoverTick(): Promise<void> {
		// 运行中不主动广播状态，避免扰动输出；结束后的 pushState 立即复检。
		if (this._maintenanceInFlight || this._running || !this._presenter) { return; }
		this._maintenanceInFlight = true;
		const lifecycle = this._lifecycleRevision;
		try {
			const changed = this._selectedExecutable
				? await this._refreshAvailability()
				: Boolean(await this.resolveExecutable({ allowDialog: false }));
			if (changed && lifecycle === this._lifecycleRevision) { await this.pushState(); }
		} catch (error) {
			console.warn('[ClassMate] failed to refresh executable availability', error);
		} finally {
			this._maintenanceInFlight = false;
		}
	}
}

/**
 * 运行记录 → Debug Journey 事件(纯函数,单测入口)。
 * exitCode === 0 且未超时、未触发交互兜底 → run_success;否则 → run_error,
 * kind 由 classifyRunError 按平台 stderr 模式判定。
 * attribution 是宿主侧算好的归属信息(源文件 URI + 题目材料键),缺省时
 * 事件不带归位字段,消费侧回退 exe 路径/文件名 stem(旧事件同形态)。
 */
export function buildRunOutcomeEvent(
	record: Pick<
		RunRecord,
		'id' | 'exePath' | 'startedAt' | 'durationMs' | 'exitCode' | 'timedOut' | 'needsInteractiveInput' | 'stdout' | 'stderr'
	>,
	ids: { sessionId: string; workspaceId: string },
	attribution?: { sourceFileUri?: string; problemKey?: string }
): RunSuccessEvent | RunErrorEvent {
	const baseEvent = {
		id: record.id,
		timestamp: record.startedAt ?? Date.now(),
		sessionId: ids.sessionId,
		workspaceId: ids.workspaceId,
		// fileUri 语义保持 exe 路径不变(侧边栏树分组/事件过滤/指纹零扰动);
		// 源文件归位走可选 sourceFileUri,消费侧优先读它。
		fileUri: vscode.Uri.file(record.exePath).toString(),
		exitCode: record.exitCode,
		durationMs: record.durationMs,
		...(attribution?.sourceFileUri ? { sourceFileUri: attribution.sourceFileUri } : {}),
		...(attribution?.problemKey ? { problemKey: attribution.problemKey } : {}),
	};

	if (record.exitCode === 0 && !record.timedOut && !record.needsInteractiveInput) {
		return { ...baseEvent, type: 'run_success' };
	}

	const classification = classifyRunError({
		exitCode: record.exitCode,
		stdout: record.stdout,
		stderr: record.stderr,
		timedOut: record.timedOut,
		needsInteractiveInput: record.needsInteractiveInput,
	});
	return {
		...baseEvent,
		type: 'run_error',
		executablePath: record.exePath,
		stdout: record.stdout,
		stderr: record.stderr,
		kind: classification.kind,
		...(classification.detail ? { errorDetail: classification.detail } : {}),
	};
}
