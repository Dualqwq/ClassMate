import * as vscode from 'vscode';
import type { BrowserExtensionImportRequest } from './types';

const DEFAULT_FILE_NAME = 'README.md';

/**
 * 处理浏览器扩展导入请求：弹出原生保存对话框，让用户选择 README.md 落点。
 * 若用户取消或写入失败，返回 false；成功返回 true。
 */
export async function handleBrowserExtensionImport(
	request: BrowserExtensionImportRequest,
	deps: BrowserExtensionImportDependencies = defaultDependencies()
): Promise<boolean> {
	const { title, markdown, url } = request;
	if (typeof markdown !== 'string' || markdown.length === 0) {
		void deps.showWarningMessage('ClassMate: 浏览器扩展导入内容为空，未保存。');
		return false;
	}

	let body = buildMarkdownBody(markdown, title, url);

	const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
	const defaultUri = vscode.Uri.joinPath(workspaceFolder ?? vscode.Uri.file('.'), DEFAULT_FILE_NAME);

	const saveUri = await deps.showSaveDialog({
		defaultUri,
		filters: { Markdown: ['md'] },
		saveLabel: '导入题目',
		title: '选择 README.md 保存位置（ClassMate 浏览器扩展导入）',
	});

	if (!saveUri) {
		return false;
	}

	try {
		await deps.writeFile(saveUri, Buffer.from(body, 'utf-8'));
		void deps.showInformationMessage(`ClassMate: 已导入 ${saveUri.fsPath}`);
		// 保存后打开文件，方便用户确认；失败不阻塞导入结果。
		try {
			await deps.showTextDocument(saveUri);
		} catch {
			// 打开失败不影响导入成功状态。
		}
		return true;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		void deps.showErrorMessage(`ClassMate: 导入保存失败：${message}`);
		return false;
	}
}

/**
 * 构造最终 Markdown 内容，可选注入 YAML frontmatter。
 */
export function buildMarkdownBody(markdown: string, title?: string, url?: string): string {
	const frontmatterLines: string[] = [];
	if (title && title.trim().length > 0) {
		frontmatterLines.push(`title: "${title.replace(/"/g, '\\"')}"`);
	}
	if (url && url.trim().length > 0) {
		frontmatterLines.push(`source: "${url.replace(/"/g, '\\"')}"`);
	}
	if (frontmatterLines.length > 0) {
		return `---\n${frontmatterLines.join('\n')}\n---\n\n${markdown}`;
	}
	return markdown;
}

export interface BrowserExtensionImportDependencies {
	showSaveDialog: (options: vscode.SaveDialogOptions) => Thenable<vscode.Uri | undefined>;
	writeFile: (uri: vscode.Uri, content: Uint8Array) => Thenable<void>;
	showTextDocument: (uri: vscode.Uri) => Thenable<vscode.TextEditor>;
	showInformationMessage: (message: string) => Thenable<unknown>;
	showWarningMessage: (message: string) => Thenable<unknown>;
	showErrorMessage: (message: string) => Thenable<unknown>;
}

function defaultDependencies(): BrowserExtensionImportDependencies {
	return {
		showSaveDialog: (options) => vscode.window.showSaveDialog(options),
		writeFile: (uri, content) => vscode.workspace.fs.writeFile(uri, content),
		showTextDocument: (uri) => vscode.window.showTextDocument(uri),
		showInformationMessage: (message) => vscode.window.showInformationMessage(message),
		showWarningMessage: (message) => vscode.window.showWarningMessage(message),
		showErrorMessage: (message) => vscode.window.showErrorMessage(message),
	};
}
