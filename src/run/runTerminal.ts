import { spawnSync } from 'child_process';
import * as vscode from 'vscode';

/**
 * "在集成终端运行"(grill Q4 拍板的交互兜底出口)。
 * 与 extension.ts 里 classmate.runCode 的终端启动同策略:
 * 复用同名终端、Windows 优先 PowerShell(带调用算子 &)、Unix 优先 bash。
 * 独立成 run 模块自有实现,避免与 extension.ts 私有助手互相 import。
 */

const CLASSMATE_RUN_TERMINAL_NAME = 'ClassMate Run';

export function runInIntegratedTerminal(executablePath: string): void {
	const existing = vscode.window.terminals.find(
		(terminal) => terminal.name === CLASSMATE_RUN_TERMINAL_NAME
	);
	const terminal = existing ?? createRunTerminal();

	const shellPath = getTerminalShellPath(terminal);
	const command = isPowerShellPath(shellPath)
		? `& "${executablePath}"`
		: `"${executablePath}"`;

	terminal.sendText(command, true);
	terminal.show(true);
}

function getTerminalShellPath(terminal: vscode.Terminal): string | undefined {
	const options = terminal.creationOptions as vscode.TerminalOptions | undefined;
	return options?.shellPath;
}

function isPowerShellPath(shellPath: string | undefined): boolean {
	if (!shellPath) {
		return process.platform === 'win32';
	}
	const lower = shellPath.toLowerCase();
	return lower.includes('powershell') || lower.includes('pwsh');
}

function createRunTerminal(): vscode.Terminal {
	if (process.platform === 'win32') {
		return vscode.window.createTerminal({
			name: CLASSMATE_RUN_TERMINAL_NAME,
			shellPath: findWindowsShell(),
		});
	}
	return vscode.window.createTerminal({
		name: CLASSMATE_RUN_TERMINAL_NAME,
		shellPath: findUnixShell(),
	});
}

function findWindowsShell(): string {
	for (const candidate of ['pwsh.exe', 'powershell.exe', 'cmd.exe']) {
		if (commandExistsOnPath(candidate)) {
			return candidate;
		}
	}
	return 'cmd.exe';
}

function findUnixShell(): string {
	for (const candidate of ['/bin/bash', '/usr/bin/bash', '/bin/sh']) {
		if (commandExistsOnPath(candidate)) {
			return candidate;
		}
	}
	return '/bin/sh';
}

function commandExistsOnPath(command: string): boolean {
	try {
		const probe = process.platform === 'win32' ? 'where' : 'command';
		const args = process.platform === 'win32' ? [command] : ['-v', command];
		const result = spawnSync(probe, args, { windowsHide: true, shell: true });
		if (process.platform === 'win32') {
			return result.status === 0 && (result.stdout?.toString().trim().length ?? 0) > 0;
		}
		return result.status === 0;
	} catch {
		return false;
	}
}
