import * as React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { RunExtensionToWebviewMessage, RunPanelSnapshot, RunRecord } from '../../src/run/types';
import { sendMessage, subscribeToExtension } from './vscodeApi';

/**
 * Run 面板(#11)。布局只保证"能跑通 + 不闪屏 + 历史常驻"(G2 审核口径),
 * 视觉精修留待后续专门设计轨。
 *
 * 交互模型(拍板):
 * - stdin 运行前填好,点"运行"一次性灌入;多轮交互暂不支持;
 * - 程序似乎在等更多输入 → ext 侧结束进程,面板提示 + 一键"在集成终端运行";
 * - 历史按 exe 分组展示,每 exe 保留最近 20 次(后端环形落盘)。
 */

const EMPTY_SNAPSHOT: RunPanelSnapshot = {
	running: false,
	lastStdin: '',
	history: [],
};

function formatTime(timestamp: number): string {
	return new Date(timestamp).toLocaleTimeString('zh-CN', { hour12: false });
}

function formatExit(record: RunRecord): string {
	if (record.needsInteractiveInput) {
		return '等待输入,已结束';
	}
	if (record.timedOut) {
		return '超时被结束';
	}
	return `退出码 ${record.exitCode ?? '未知'}`;
}

const RunRecordView: React.FC<{ record: RunRecord; live?: boolean }> = ({ record, live }) => (
	<div className={`run-record ${live ? 'live' : ''}`}>
		<div className="run-record-meta">
			{formatTime(record.startedAt)} · {formatExit(record)} · {record.durationMs}ms
			{record.outputTruncated && <span className="run-truncated-tag">(输出已截断)</span>}
		</div>
		{record.stdout && (
			<pre className="run-output stdout">{record.stdout}</pre>
		)}
		{record.stderr && (
			<pre className="run-output stderr">{record.stderr}</pre>
		)}
		{!record.stdout && !record.stderr && (
			<div className="run-record-empty">(无输出)</div>
		)}
	</div>
);

export const RunPanel: React.FC = () => {
	const [snapshot, setSnapshot] = useState<RunPanelSnapshot>(EMPTY_SNAPSHOT);
	// 首帧 run:state 到达前不渲染 stdin 输入框:defaultValue 只在挂载时生效,
	// 等水合后再挂载,保证上次灌入的 stdin 能回填。
	const [hydrated, setHydrated] = useState(false);
	// 运行中的流式输出(未结束的本次运行),结束后由 lastResult 接管展示。
	const [liveOutput, setLiveOutput] = useState<{ stdout: string; stderr: string }>({
		stdout: '',
		stderr: '',
	});
	const stdinRef = useRef<HTMLTextAreaElement>(null);

	useEffect(() => {
		const unsubscribe = subscribeToExtension((message) => {
			const runMessage = message as RunExtensionToWebviewMessage;
			switch (runMessage.type) {
				case 'run:state':
					setSnapshot(runMessage.state);
					setHydrated(true);
					// 新一轮运行开始时清空流式缓冲;结束时不清,等 lastResult 渲染后
					// 由下一次 run:state(running=false 且带 lastResult)一并切换。
					if (runMessage.state.running) {
						setLiveOutput({ stdout: '', stderr: '' });
					}
					break;
				case 'run:output':
					setLiveOutput((prev) => ({
						...prev,
						[runMessage.stream]: prev[runMessage.stream] + runMessage.text,
					}));
					break;
			}
		});
		sendMessage({ type: 'run:requestState' });
		return unsubscribe;
	}, []);

	const handleRun = useCallback(() => {
		const stdin = stdinRef.current?.value ?? '';
		sendMessage({ type: 'run:start', stdin });
	}, []);

	const handleOpenInTerminal = useCallback((exePath: string) => {
		sendMessage({ type: 'run:openInTerminal', exePath });
	}, []);

	const lastResult = snapshot.lastResult;
	const showLive = snapshot.running;

	return (
		<div className="classmate-app run-panel">
			<header className="classmate-header">
				<div className="classmate-header-row">
					<div className="classmate-brand">
						<div className="classmate-mark" aria-hidden="true">C</div>
						<div className="classmate-brand-copy">
							<div className="classmate-title">ClassMate 运行</div>
							<div className="classmate-subtitle">预填 stdin,一次性灌入运行</div>
						</div>
					</div>
					<span className="classmate-spacer" />
					<button
						className="icon-button"
						onClick={() => sendMessage({ type: 'run:pickExecutable' })}
						title="手动选择可执行文件"
					>
						选择 exe
					</button>
				</div>
			</header>

			<div className="run-body">
				<div className="run-exe-line">
					{snapshot.executable ? (
						<span className="run-exe-path" title={snapshot.executable.path}>
							目标:{snapshot.executable.path}
						</span>
					) : (
						<span className="run-notice">
							{snapshot.notice ?? '尚未发现可执行文件,请先编译。'}
						</span>
					)}
				</div>

				<div className="run-stdin-block">
					<label className="run-stdin-label" htmlFor="run-stdin">
						标准输入(stdin,运行前填好,一次性灌入)
					</label>
					{hydrated && (
						<textarea
							id="run-stdin"
							ref={stdinRef}
							className="run-stdin-input"
							rows={4}
							defaultValue={snapshot.lastStdin}
							placeholder={'每行一个输入,例如:\n5\n1 2 3 4 5'}
							disabled={snapshot.running}
						/>
					)}
					<button
						className="primary-button run-start-button"
						onClick={handleRun}
						disabled={snapshot.running}
					>
						{snapshot.running ? '运行中…' : '运行'}
					</button>
				</div>

				{snapshot.interactiveHint && (
					<div className="run-interactive-hint">
						<div>
							程序似乎在等待更多输入。需要交互输入时,请在终端手动运行。
						</div>
						<div className="run-interactive-actions">
							<button
								className="primary-button"
								onClick={() => handleOpenInTerminal(snapshot.interactiveHint!.exePath)}
							>
								在集成终端运行
							</button>
							<button
								className="icon-button"
								onClick={() => sendMessage({ type: 'run:dismissInteractiveHint' })}
							>
								知道了
							</button>
						</div>
					</div>
				)}

				{showLive && (
					<div className="run-current">
						<div className="run-section-title">本次运行(实时)</div>
						{(liveOutput.stdout || liveOutput.stderr) ? (
							<>
								{liveOutput.stdout && <pre className="run-output stdout">{liveOutput.stdout}</pre>}
								{liveOutput.stderr && <pre className="run-output stderr">{liveOutput.stderr}</pre>}
							</>
						) : (
							<div className="run-record-empty">等待输出…</div>
						)}
					</div>
				)}

				{!showLive && lastResult && (
					<div className="run-current">
						<div className="run-section-title">最近一次运行</div>
						<RunRecordView record={lastResult} />
					</div>
				)}

				<div className="run-history">
					<div className="run-section-title">运行历史(每 exe 保留最近 20 次)</div>
					{snapshot.history.length === 0 && (
						<div className="run-record-empty">还没有运行记录。</div>
					)}
					{snapshot.history.map((group) => (
						<details key={group.exePath} className="run-history-group">
							<summary title={group.exePath}>
								{group.exePath.split(/[\\/]/).pop()}
								<span className="run-history-count">{group.records.length} 次</span>
							</summary>
							{group.records.map((record) => (
								<RunRecordView key={record.id} record={record} />
							))}
						</details>
					))}
				</div>
			</div>
		</div>
	);
};
