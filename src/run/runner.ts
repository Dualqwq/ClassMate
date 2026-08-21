import { spawn, spawnSync } from 'child_process';

/**
 * 运行器(#11):spawn 学生程序、一次性灌入预填 stdin、捕获 stdout/stderr。
 * 纯 Node 实现,不 import vscode。
 *
 * 与 compilerService.spawnExecutable 的差异(有意不改动该文件,轨 A 持有):
 * - 支持 stdin 灌入(写完后保持管道打开,用于交互检测);
 * - 实时输出回调(面板流式回显);
 * - 交互兜底检测(grill Q4 拍板):stdin 已灌完而程序长时间无任何输出,
 *   判定"在等待更多输入",主动结束进程并置 needsInteractiveInput,
 *   不让程序挂到硬超时才报错。
 *
 * 已知取舍:无输出即判等输入是启发式——长时间静默计算的程序会被误伤,
 * 此时用户可按提示改去集成终端运行。idleTimeoutMs 取得保守(默认 5s)。
 */

export interface RunProcessResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	durationMs: number;
	/** 硬超时(timeoutMs)被杀。 */
	timedOut: boolean;
	/** stdin 灌完后程序无输出等待更多输入(idleTimeoutMs),被主动结束。 */
	needsInteractiveInput: boolean;
}

export interface RunProcessOptions {
	/** 预填 stdin,运行开始时一次性灌入;多轮交互暂不支持。 */
	stdin?: string;
	cwd?: string;
	/** 硬超时,默认 30000ms(与编译侧一致)。 */
	timeoutMs?: number;
	/** 无输出判定"等待更多输入"的窗口,默认 5000ms。 */
	idleTimeoutMs?: number;
	onOutput?: (stream: 'stdout' | 'stderr', text: string) => void;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_IDLE_TIMEOUT_MS = 5_000;

export function runExecutable(
	executablePath: string,
	options: RunProcessOptions = {},
	triedShell = false
): Promise<RunProcessResult> {
	const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const idleTimeout = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;

	return new Promise((resolve, reject) => {
		const start = Date.now();
		let stdout = '';
		let stderr = '';
		let timedOut = false;
		let needsInteractiveInput = false;
		let settled = false;

		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(executablePath, [], {
				cwd: options.cwd,
				env: process.env,
				shell: triedShell && process.platform === 'win32',
				windowsHide: true,
			});
		} catch (syncError) {
			// Windows 上直接 spawn .cmd/.bat 会同步抛 EINVAL(CVE-2024-27980
			// 之后的行为);与异步 'error' 一样走 shell 回退。
			if (process.platform === 'win32' && !triedShell) {
				runExecutable(executablePath, options, true).then(resolve, reject);
				return;
			}
			reject(syncError);
			return;
		}

		const finish = (result: Omit<RunProcessResult, 'durationMs'>) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timeoutHandle);
			clearIdleTimer();
			resolve({ ...result, durationMs: Date.now() - start });
		};

		// Windows 上 shell 回退路径(.cmd 包装)里 child.kill 只杀 shell
		// 本身,子进程树存活并继续持有 stdio 管道,'close' 永不触发——
		// 用 taskkill /T 杀整棵树;直接 spawn 的真实 exe 无子进程,/T 无害。
		const killProcessTree = () => {
			if (process.platform === 'win32' && child.pid !== undefined) {
				try {
					spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
					return;
				} catch {
					// 回落到普通 kill
				}
			}
			child.kill('SIGTERM');
		};

		// 交互兜底:stdin 灌完后,程序既没有退出也没有任何输出超过
		// idleTimeout,视为"在等待更多输入"。任何输出都会重置该计时器
		// (程序仍在正常推进),所以只有真正卡住的程序才会命中。
		let idleTimer: ReturnType<typeof setTimeout> | undefined;
		const armIdleTimer = () => {
			clearIdleTimer();
			idleTimer = setTimeout(() => {
				needsInteractiveInput = true;
				killProcessTree();
			}, idleTimeout);
		};
		const clearIdleTimer = () => {
			if (idleTimer !== undefined) {
				clearTimeout(idleTimer);
				idleTimer = undefined;
			}
		};

		const timeoutHandle = setTimeout(() => {
			timedOut = true;
			killProcessTree();
		}, timeout);

		child.stdout?.on('data', (data: Buffer) => {
			const text = data.toString('utf-8');
			stdout += text;
			options.onOutput?.('stdout', text);
			armIdleTimer();
		});

		child.stderr?.on('data', (data: Buffer) => {
			const text = data.toString('utf-8');
			stderr += text;
			options.onOutput?.('stderr', text);
			armIdleTimer();
		});

		child.on('error', async (error) => {
			if (process.platform === 'win32' && !triedShell) {
				// 与 spawnProcess 一致的 Windows 回退:直接 spawn 失败改走 shell。
				clearTimeout(timeoutHandle);
				clearIdleTimer();
				try {
					const result = await runExecutable(executablePath, options, true);
					finish(result);
				} catch (shellError) {
					reject(shellError);
				}
			} else {
				reject(error);
			}
		});

		child.on('close', (exitCode) => {
			finish({ exitCode, stdout, stderr, timedOut, needsInteractiveInput });
		});

		// 一次性灌入预填 stdin。管道保持打开(不 end):若程序还想读更多,
		// 它会阻塞在 read 上,由 idle 计时器识别;若直接 end,程序读到 EOF
		// 会以未定义行为继续(如 scanf 返回 EOF 后死循环),反而无法区分。
		const stdinText = options.stdin ?? '';
		if (stdinText.length > 0 && child.stdin) {
			// 保证最后一行以换行结尾:管道里裸 token 没有分隔符也没有 EOF 时,
			// scanf 等格式化读会把它当作"未输入完"而继续阻塞。
			const payload = stdinText.endsWith('\n') ? stdinText : `${stdinText}\n`;
			child.stdin.write(payload, () => {
				armIdleTimer();
			});
		} else {
			armIdleTimer();
		}
	});
}
