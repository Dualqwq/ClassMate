import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

/**
 * 浏览器扩展导入链路的共享 OutputChannel（"ClassMate Browser Import"）。
 * 用于在 VS Code 侧定位"网页选中 → content script → service worker →
 * 本地 HTTP 端点 → showSaveDialog → 写文件"链路断在哪一段。
 */
export function browserImportLog(message: string): void {
	if (!channel) {
		channel = vscode.window.createOutputChannel('ClassMate Browser Import');
	}
	channel.appendLine(`[${new Date().toISOString()}] ${message}`);
}
