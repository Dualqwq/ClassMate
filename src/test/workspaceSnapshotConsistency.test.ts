import * as assert from 'assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it } from 'mocha';
import * as vscode from 'vscode';
import { WorkspaceContextLoader } from '../workspace/workspaceContextLoader';
import { buildWorkspaceSnapshot } from '../workspace/workspaceSnapshotBuilder';
import type { WorkspaceCatalog } from '../workspace/types';

async function createCatalog(directory: string, fileName: string): Promise<WorkspaceCatalog> {
	const filePath = path.join(directory, fileName);
	const stat = await fs.stat(filePath);
	return {
		files: [{
			path: fileName,
			uri: vscode.Uri.file(filePath).toString(),
			kind: 'code',
			size: stat.size,
			modifiedAt: stat.mtimeMs,
		}],
		questionFiles: [],
	};
}

describe('workspace snapshot consistency', () => {
	it('prefers the unsaved editor buffer over the on-disk content', async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'classmate-snapshot-'));
		try {
			const diskContent = 'int value = 1;\n';
			const bufferContent = 'int value = 2; // unsaved edit\n';
			await fs.writeFile(path.join(directory, 'monster.h'), diskContent, 'utf8');
			const catalog = await createCatalog(directory, 'monster.h');

			const document = await vscode.workspace.openTextDocument(
				vscode.Uri.file(path.join(directory, 'monster.h'))
			);
			const editor = await vscode.window.showTextDocument(document);
			await editor.edit((edit) =>
				edit.replace(
					new vscode.Range(0, 0, document.lineCount, 0),
					bufferContent
				)
			);
			assert.ok(document.isDirty, 'test precondition: buffer must be unsaved');

			let loadedContent = '';
			try {
				const loaded = await new WorkspaceContextLoader().load(catalog, [{
					source: 'workspace',
					target: 'monster.h',
					required: true,
					reason: 'Unsaved buffer must reach the model.',
				}]);

				assert.strictEqual(loaded.length, 1);
				loadedContent = loaded[0].content;
				assert.strictEqual(loadedContent, bufferContent);
			} finally {
				try {
					await editor.edit((edit) =>
						edit.replace(
							new vscode.Range(0, 0, document.lineCount, 0),
							diskContent
						)
					);
				} catch {
					// 恢复失败也要继续关闭编辑器,避免临时目录被锁。
				}
				await vscode.commands.executeCommand('workbench.action.closeAllEditors');
				await new Promise((resolve) => setTimeout(resolve, 200));
			}
			void loadedContent;
		} finally {
			for (let attempt = 0; attempt < 5; attempt++) {
				try {
					await fs.rm(directory, { recursive: true, force: true });
					break;
				} catch {
					await new Promise((resolve) => setTimeout(resolve, 200));
				}
			}
		}
	});

	it('rejects stale route preview when the buffer changed after the preview was taken', async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'classmate-preview-'));
		try {
			const diskContent = 'int value = 1;\n';
			const editedContent = 'int value = 2; // changed while route call was in flight\n';
			await fs.writeFile(path.join(directory, 'monster.h'), diskContent, 'utf8');
			const filePath = path.join(directory, 'monster.h');
			const stat = await fs.stat(filePath);

			const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
			const editor = await vscode.window.showTextDocument(document);
			try {
				const previewLoader = new WorkspaceContextLoader();
				const preview = await previewLoader.load({
					files: [{
						path: 'monster.h',
						uri: vscode.Uri.file(filePath).toString(),
						kind: 'code',
						size: stat.size,
						modifiedAt: stat.mtimeMs,
					}],
					questionFiles: [],
				}, [{
					source: 'workspace',
					target: 'monster.h',
					required: true,
					reason: 'Route preview.',
				}]);
				assert.strictEqual(preview[0].content, diskContent);

				await editor.edit((edit) =>
					edit.replace(new vscode.Range(0, 0, document.lineCount, 0), editedContent)
				);

				const freshLoader = new WorkspaceContextLoader();
				const reloaded = await freshLoader.load({
					files: [{
						path: 'monster.h',
						uri: vscode.Uri.file(filePath).toString(),
						kind: 'code',
						size: stat.size,
						modifiedAt: stat.mtimeMs,
					}],
					questionFiles: [],
				}, [{
					source: 'workspace',
					target: 'monster.h',
					required: true,
					reason: 'Answer must see the latest buffer.',
				}]);

				assert.strictEqual(reloaded[0].content, editedContent);
				assert.notStrictEqual(reloaded[0].contentHash, preview[0].contentHash);
			} finally {
				try {
					await editor.edit((edit) =>
						edit.replace(new vscode.Range(0, 0, document.lineCount, 0), diskContent)
					);
				} catch {
					// 恢复失败也要继续关闭编辑器,避免临时目录被锁。
				}
				await vscode.commands.executeCommand('workbench.action.closeAllEditors');
				await new Promise((resolve) => setTimeout(resolve, 200));
			}
		} finally {
			for (let attempt = 0; attempt < 5; attempt++) {
				try {
					await fs.rm(directory, { recursive: true, force: true });
					break;
				} catch {
					await new Promise((resolve) => setTimeout(resolve, 200));
				}
			}
		}
	});

	it('keeps the snapshot id stable while file content is unchanged', async () => {
		const minimal = {
			catalog: {
				files: [{
					path: 'monster.h',
					uri: 'file:///w/monster.h',
					kind: 'code' as const,
					size: 40,
					modifiedAt: 1_000,
				}],
				questionFiles: [],
			},
			activeFilePreview: 'int value = 1;',
		};
		const loadedItems = [{
			path: 'monster.h',
			kind: 'code' as const,
			content: 'int value = 1;',
			contentHash: 'hash-a',
			reason: 'test',
		}];
		const first = buildWorkspaceSnapshot(minimal, loadedItems);
		const second = buildWorkspaceSnapshot(minimal, loadedItems);

		assert.strictEqual(first.snapshotId, second.snapshotId);
	});
});
