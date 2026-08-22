import * as vscode from 'vscode';
import type { BrowserExtensionImportRequest } from './types';
import { browserImportLog } from './log';

const DEFAULT_FILE_NAME = 'README.md';

/**
 * 处理浏览器扩展导入请求：弹出原生保存对话框，让用户选择 README.md 落点。
 * 若用户取消或写入失败，返回 false；成功返回 true。
 */
export async function handleBrowserExtensionImport(
	request: BrowserExtensionImportRequest,
	deps: BrowserExtensionImportDependencies = defaultDependencies()
): Promise<boolean> {
	const log = deps.log ?? (() => undefined);
	const { title, markdown, url } = request;
	if (typeof markdown !== 'string' || markdown.length === 0) {
		log('rejected: markdown empty or missing');
		void deps.showWarningMessage('ClassMate: 浏览器扩展导入内容为空，未保存。');
		return false;
	}
	log(`import request received: url=${url ?? 'none'}, markdown ${markdown.length} chars`);

	let body = buildMarkdownBody(markdown, title, url);

	const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
	const defaultUri = vscode.Uri.joinPath(workspaceFolder ?? vscode.Uri.file('.'), DEFAULT_FILE_NAME);

	log(`showing native save dialog (defaultUri=${defaultUri.fsPath})`);
	const saveUri = await deps.showSaveDialog({
		defaultUri,
		filters: { Markdown: ['md'] },
		saveLabel: '导入题目',
		title: '选择 README.md 保存位置（ClassMate 浏览器扩展导入）',
	});

	if (!saveUri) {
		log('save dialog cancelled by user, nothing written');
		return false;
	}
	log(`save dialog returned ${saveUri.fsPath}, writing file`);

	try {
		await deps.writeFile(saveUri, Buffer.from(body, 'utf-8'));
		log(`file written: ${saveUri.fsPath}`);
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
		log(`file write failed: ${message}`);
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
	/** 关键节点日志，便于定位导入链路断点；缺省（自定义 deps 未传时）不输出。 */
	log?: (message: string) => void;
}

function defaultDependencies(): BrowserExtensionImportDependencies {
	return {
		showSaveDialog: (options) => vscode.window.showSaveDialog(options),
		writeFile: (uri, content) => vscode.workspace.fs.writeFile(uri, content),
		showTextDocument: (uri) => vscode.window.showTextDocument(uri),
		showInformationMessage: (message) => vscode.window.showInformationMessage(message),
		showWarningMessage: (message) => vscode.window.showWarningMessage(message),
		showErrorMessage: (message) => vscode.window.showErrorMessage(message),
		log: (message) => browserImportLog(message),
	};
}
