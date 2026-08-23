import * as vscode from 'vscode';

/**
 * [ClassMate Theme] 专用输出通道:主题链路每一步的端到端日志(G5 第六轮)。
 * 背景:五轮复测全部"静默失败"——结构断言与纯函数单测都绿,唯独真实
 * 运行时的组装层(server 回调 ↔ 面板注册表 ↔ webview 实例)不可测。
 * 本通道让复测一次即可直接定位断环:收到 POST(字段数)/已持久化/
 * 广播目标数/每次送达结果/webview 应用回执(ack)。广播目标数为 0 时
 * 升级为显式 ERROR 并自动弹出面板,不再可能静默。
 */

let channel: vscode.OutputChannel | undefined;

function ensureChannel(): vscode.OutputChannel {
	channel ??= vscode.window.createOutputChannel('ClassMate Theme');
	return channel;
}

export function themeLog(line: string): void {
	const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
	ensureChannel().appendLine(`[${time}] ${line}`);
}

export function themeLogError(line: string): void {
	themeLog(`ERROR: ${line}`);
	ensureChannel().show(true);
}
