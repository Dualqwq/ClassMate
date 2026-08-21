/**
 * Run 面板(#11)与运行历史的共享类型。
 *
 * 消息桥契约与 chat 一致:webview → extension 的新消息先在这里登记
 * (chat/types.ts 管 chat 通道,run 通道独立,互不 import 对方的消息类型)。
 */

/** exe 发现来源(grill R2-Q1 拍板的分级链)。 */
export type ExecutableSource =
	/** make 场景:解析 make 回显链接行 `-o <target>` 命中。 */
	| 'make-echo'
	/** make 场景兜底:工作区根目录最新 `.exe`。 */
	| 'latest-exe'
	/** g++ 场景:由 active 源文件推导(resolveOutputPath 语义)。 */
	| 'source-derived'
	/** 最后手段:用户在 showOpenDialog 里手动挑选。 */
	| 'user-picked';

/** 一次运行的持久化记录(stdout/stderr 已按 64KB 头尾截断)。 */
export interface RunRecord {
	id: string;
	/** 被运行 exe 的绝对路径(原始形态,未归一化)。 */
	exePath: string;
	startedAt: number;
	durationMs: number;
	exitCode: number | null;
	/** 硬超时被杀。 */
	timedOut: boolean;
	/** stdin 已灌完、程序仍无输出等待更多输入(交互兜底信号)。 */
	needsInteractiveInput: boolean;
	/** 本次灌入的 stdin(原文,不截断;学生输入量级很小)。 */
	stdin: string;
	stdout: string;
	stderr: string;
	/** stdout 或 stderr 被 64KB 头尾截断过。 */
	outputTruncated: boolean;
}

/** 面板全量状态(ext → webview 一次性同步,避免增量补丁协议)。 */
export interface RunPanelSnapshot {
	/** 当前选中的 exe;undefined 表示尚未发现/未选择。 */
	executable?: {
		path: string;
		source: ExecutableSource;
	};
	/** 发现失败/需要用户动作的兜底文案(如"请先编译")。 */
	notice?: string;
	running: boolean;
	/** 正在运行的进程启动时间(running 时存在)。 */
	currentStartedAt?: number;
	/** 上次灌入的 stdin(回填输入框,跨次运行保留)。 */
	lastStdin: string;
	/** 最近一次运行结果(含本次刚结束的)。 */
	lastResult?: RunRecord;
	/** 交互兜底:程序似乎在等待更多输入。 */
	interactiveHint?: {
		exePath: string;
	};
	/** 运行历史,按 exe 分组;每组内新的在前。 */
	history: Array<{
		exePath: string;
		records: RunRecord[];
	}>;
}

// webview → extension
export type RunWebviewToExtensionMessage =
	| { type: 'run:requestState' }
	| { type: 'run:start'; stdin: string }
	| { type: 'run:pickExecutable' }
	| { type: 'run:openInTerminal'; exePath: string }
	| { type: 'run:dismissInteractiveHint' };

// extension → webview
export type RunExtensionToWebviewMessage =
	| { type: 'run:state'; state: RunPanelSnapshot }
	/** 运行中的实时输出增量(先展示,结束后再随 run:state 落历史)。 */
	| { type: 'run:output'; stream: 'stdout' | 'stderr'; text: string };
