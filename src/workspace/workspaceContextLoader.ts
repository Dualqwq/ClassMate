import * as path from 'path';
import * as vscode from 'vscode';
import type { ContextRequest } from '../graph/types';
import { extractMarkdownSection } from '../skill/markdownSectionExtractor';
import { hashContent } from '../skill/skillContentLoader';
import { extractPdfUri, formatPdfExtraction } from './pdfExtractor';
import type {
	LoadedWorkspaceItem,
	WorkspaceCatalog,
	WorkspaceFileEntry,
} from './types';

export interface WorkspaceLoadLimits {
	maxRequests: number;
	maxFileBytes: number;
	maxTotalBytes: number;
}

const DEFAULT_LIMITS: WorkspaceLoadLimits = {
	maxRequests: 5,
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
	constructor(private readonly _limits: WorkspaceLoadLimits = DEFAULT_LIMITS) {}

	public async load(
		catalog: WorkspaceCatalog,
		requests: ContextRequest[]
	): Promise<LoadedWorkspaceItem[]> {
		const workspaceRequests = requests.filter((request) => request.source === 'workspace');
		if (workspaceRequests.length > this._limits.maxRequests) {
			throw new Error(`Too many workspace context requests: ${workspaceRequests.length}`);
		}

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
			if (entry.kind === 'pdf') {
				content = formatPdfExtraction(await extractPdfUri(uri));
			} else {
				const bytes = await vscode.workspace.fs.readFile(uri);
				if (bytes.byteLength > this._limits.maxFileBytes) {
					throw new Error(`Workspace file exceeds size limit after reading: ${entry.path}`);
				}
				content = Buffer.from(bytes).toString('utf8');
			}
			content = selectSection(content, entry, request.section);
			const contentBytes = Buffer.byteLength(content, 'utf8');
			if (contentBytes > this._limits.maxFileBytes) {
				throw new Error(`Workspace content exceeds size limit after extraction: ${entry.path}`);
			}
			if (totalBytes + contentBytes > this._limits.maxTotalBytes) {
				throw new Error('Workspace context requests exceed the total byte budget after extraction.');
			}
			totalBytes += contentBytes;
			loaded.push({
				path: entry.path,
				kind: entry.kind,
				content,
				contentHash: hashContent(content),
				reason: request.reason,
			});
		}

		const unique = new Map<string, LoadedWorkspaceItem>();
		for (const item of loaded) {
			unique.set(`${normalizedPath(item.path)}\u0000${item.contentHash}`, item);
		}
		return [...unique.values()];
	}
}
