import * as vscode from 'vscode';

/**
 * Loads skill markdown files from the extension's skill directory.
 * Files are cached by URI after the first read to avoid repeated disk I/O.
 */
export class PromptLoader {
	private _cache: Map<string, string> = new Map();

	/**
	 * Load a single markdown file relative to the skill directory.
	 */
	public async load(skillDir: vscode.Uri, fileName: string): Promise<string> {
		const fileUri = vscode.Uri.joinPath(skillDir, fileName);
		const cacheKey = fileUri.toString();

		const cached = this._cache.get(cacheKey);
		if (cached !== undefined) {
			return cached;
		}

		const raw = await vscode.workspace.fs.readFile(fileUri);
		const text = Buffer.from(raw).toString('utf-8');
		this._cache.set(cacheKey, text);
		return text;
	}

	/**
	 * Load multiple markdown files in parallel.
	 */
	public async loadAll(skillDir: vscode.Uri, fileNames: string[]): Promise<string[]> {
		return Promise.all(fileNames.map((name) => this.load(skillDir, name)));
	}

	/**
	 * Clear the in-memory cache. Useful when skill files change during development.
	 */
	public clearCache(): void {
		this._cache.clear();
	}
}

export function createSkillLoader(): PromptLoader {
	return new PromptLoader();
}
