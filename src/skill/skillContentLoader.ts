import { createHash } from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';

export const DEFAULT_SKILL_FILE_LIMIT_BYTES = 512 * 1024;

export function normalizeSkillRelativePath(relativePath: string): string {
	const normalized = relativePath.replace(/\\/g, '/').trim();
	if (
		normalized.length === 0 ||
		normalized.startsWith('/') ||
		/^[a-zA-Z]:/.test(normalized)
	) {
		throw new Error(`Invalid Skill path: ${relativePath}`);
	}

	const segments = normalized.split('/');
	if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
		throw new Error(`Unsafe Skill path: ${relativePath}`);
	}

	return segments.join('/');
}
export function hashContent(content: string): string {
	return createHash('sha256').update(content, 'utf8').digest('hex');
}

export class SkillContentLoader {
	private readonly _cache = new Map<string, string>();

	constructor(
		private readonly _skillDir: vscode.Uri,
		private readonly _maxFileBytes = DEFAULT_SKILL_FILE_LIMIT_BYTES
	) {}

	public async loadText(relativePath: string): Promise<string> {
		const safePath = normalizeSkillRelativePath(relativePath);
		const cached = this._cache.get(safePath);
		if (cached !== undefined) {
			return cached;
		}

		const fileUri = vscode.Uri.joinPath(this._skillDir, ...safePath.split('/'));
		const stat = await vscode.workspace.fs.stat(fileUri);
		if (stat.type !== vscode.FileType.File) {
			throw new Error(`Skill path is not a file: ${safePath}`);
		}
		if (stat.size > this._maxFileBytes) {
			throw new Error(`Skill file exceeds ${this._maxFileBytes} bytes: ${safePath}`);
		}

		const bytes = await vscode.workspace.fs.readFile(fileUri);
		if (bytes.byteLength > this._maxFileBytes) {
			throw new Error(`Skill file exceeds ${this._maxFileBytes} bytes: ${safePath}`);
		}
		const text = Buffer.from(bytes).toString('utf8');
		this._cache.set(safePath, text);
		return text;
	}

	public async loadJson<T>(relativePath: string): Promise<T> {
		const text = await this.loadText(relativePath);
		try {
			return JSON.parse(text) as T;
		} catch (error) {
			throw new Error(
				`Invalid JSON in ${normalizeSkillRelativePath(relativePath)}: ${
					error instanceof Error ? error.message : String(error)
				}`
			);
		}
	}

	public clear(relativePath?: string): void {
		if (relativePath === undefined) {
			this._cache.clear();
			return;
		}
		this._cache.delete(normalizeSkillRelativePath(relativePath));
	}

	public get skillDir(): vscode.Uri {
		return this._skillDir;
	}
}

export function isMarkdownReferencePath(relativePath: string): boolean {
	const safePath = normalizeSkillRelativePath(relativePath);
	return safePath.startsWith('references/') && path.posix.extname(safePath).toLowerCase() === '.md';
}
