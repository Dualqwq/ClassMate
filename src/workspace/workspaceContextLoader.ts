import * as path from 'path';
import * as vscode from 'vscode';
import type { ContextRequest } from '../graph/types';
import { extractMarkdownSection } from '../skill/markdownSectionExtractor';
import { hashContent } from '../skill/skillContentLoader';
import { extractPdfUri, formatPdfExtraction } from './pdfExtractor';
import { decodeDiskTextFile } from './textEncoding';
import type {
	LoadedWorkspaceItem,
	WorkspaceCatalog,
	WorkspaceFileEntry,
} from './types';

export interface WorkspaceLoadLimits {
	maxFileBytes: number;
	maxTotalBytes: number;
}

const DEFAULT_LIMITS: WorkspaceLoadLimits = {
	maxFileBytes: 200 * 1024,
	maxTotalBytes: 600 * 1024,
};

function normalizedPath(value: string): string {
	return value.replace(/\\/g, '/').replace(/^\.\//, '').toLocaleLowerCase();
}

function selectCatalogEntry(catalog: WorkspaceCatalog, target: string): WorkspaceFileEntry | undefined {
	const normalizedTarget = normalizedPath(target);
	return catalog.files.find((entry) =>
		normalizedPath(entry.path) === normalizedTarget ||
		entry.uri.toLocaleLowerCase() === target.toLocaleLowerCase()
	);
}

function extractLineRange(content: string, section: string): string | undefined {
	const match = section.match(/^lines?\s*:\s*(\d+)\s*-\s*(\d+)$/i);
	if (!match) {
		return undefined;
	}
	const start = Number(match[1]);
	const end = Number(match[2]);
	if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) {
		throw new Error(`Invalid line range: ${section}`);
	}
	const lines = content.replace(/\r\n/g, '\n').split('\n');
	return lines.slice(start - 1, Math.min(end, lines.length)).join('\n');
}

function selectSection(content: string, entry: WorkspaceFileEntry, section?: string): string {
	if (!section) {
		return content;
	}
	const lineRange = extractLineRange(content, section);
	if (lineRange !== undefined) {
		return lineRange;
	}
	if (path.posix.extname(entry.path.replace(/\\/g, '/')).toLowerCase() === '.md') {
		return extractMarkdownSection(
			content,
			section.split('>').map((part) => part.trim()).filter(Boolean)
		).content;
	}
	throw new Error(`Sections are unsupported for this file type: ${entry.path}`);
}

	export class WorkspaceContextLoader {
	/**
	 * 之前加载的条目当前是否仍然新鲜。缓冲区加载的条目对比打开文档的
	 * version(每次编辑/撤销/重做单调递增);磁盘加载的条目默认新鲜,
	 * 磁盘变更由 catalog 指纹反映。
	 */
	public isItemFresh(catalog: WorkspaceCatalog, item: LoadedWorkspaceItem): boolean {
		if (item.bufferVersion === undefined) {
			return true;
		}
		const entry = selectCatalogEntry(catalog, item.path);
		if (!entry) {
			return false;
		}
		const document = vscode.workspace.textDocuments.find((candidate) =>
			candidate.uri.toString().toLocaleLowerCase() === entry.uri.toLocaleLowerCase()
		);
		if (!document) {
			return true;
		}
		return document.version === item.bufferVersion;
	}

	constructor(private readonly _limits: WorkspaceLoadLimits = DEFAULT_LIMITS) {}

	public async load(
		catalog: WorkspaceCatalog,
		requests: ContextRequest[]
	): Promise<LoadedWorkspaceItem[]> {
		const requestKeys = new Set<string>();
		const workspaceRequests = requests
			.filter((request) => request.source === 'workspace')
			.filter((request) => {
				const key = `${normalizedPath(request.target)}\u0000${request.section ?? ''}`;
				if (requestKeys.has(key)) {
					return false;
				}
				requestKeys.add(key);
				return true;
			});

		const loaded: LoadedWorkspaceItem[] = [];
		let totalBytes = 0;
		for (const request of workspaceRequests) {
			const entry = selectCatalogEntry(catalog, request.target);
			if (!entry) {
				if (request.required) {
					throw new Error(`Workspace context target is not in the catalog: ${request.target}`);
				}
				continue;
			}
			if (entry.size > this._limits.maxFileBytes) {
				if (request.required) {
					throw new Error(`Workspace file exceeds size limit: ${entry.path}`);
				}
				continue;
			}
			if (totalBytes + entry.size > this._limits.maxTotalBytes) {
				if (request.required) {
					throw new Error('Workspace context requests exceed the total byte budget.');
				}
				continue;
			}

			const uri = vscode.Uri.parse(entry.uri);
			let content: string;
			let bufferVersion: number | undefined;
			if (entry.kind === 'pdf') {
				content = formatPdfExtraction(await extractPdfUri(uri));
			} else {
				// 已打开的文档优先读取编辑器缓冲区:学生常在未保存状态下提问,
				// 只读磁盘会让模型看到旧代码(bug1 类事实冲突的直接来源之一)。
				const openDocument = vscode.workspace.textDocuments.find((document) =>
					document.uri.toString().toLocaleLowerCase() === entry.uri.toLocaleLowerCase()
				);
				if (openDocument) {
					content = openDocument.getText();
					bufferVersion = openDocument.version;
				} else {
					const bytes = await vscode.workspace.fs.readFile(uri);
					if (bytes.byteLength > this._limits.maxFileBytes) {
						throw new Error(`Workspace file exceeds size limit after reading: ${entry.path}`);
					}
					content = decodeDiskTextFile(bytes);
				}
			}
			content = selectSection(content, entry, request.section);
			const contentBytes = Buffer.byteLength(content, 'utf8');
			if (contentBytes > this._limits.maxFileBytes) {
				if (request.required) {
					throw new Error(`Workspace content exceeds size limit after extraction: ${entry.path}`);
				}
				continue;
			}
			if (totalBytes + contentBytes > this._limits.maxTotalBytes) {
				if (request.required) {
					throw new Error('Workspace context requests exceed the total byte budget after extraction.');
				}
				continue;
			}
			totalBytes += contentBytes;
			loaded.push({
				path: entry.path,
				kind: entry.kind,
				content,
				contentHash: hashContent(content),
				reason: request.reason,
				bufferVersion,
			});
		}

		const unique = new Map<string, LoadedWorkspaceItem>();
		for (const item of loaded) {
			unique.set(`${normalizedPath(item.path)}\u0000${item.contentHash}`, item);
		}
		return [...unique.values()];
	}
}
