import { createHash } from 'crypto';
import type {
	LoadedWorkspaceItem,
	MinimalWorkspaceContext,
	WorkspaceContextSnapshot,
} from './types';

export function buildWorkspaceSnapshot(
	minimal: MinimalWorkspaceContext,
	loadedItems: LoadedWorkspaceItem[]
): WorkspaceContextSnapshot {
	const createdAt = Date.now();
	// snapshotId 只由内容决定:同一份工作区两次捕获必须得到同一 ID,
	// 否则"内容未变"也会被误判为新版本(createdAt/mtime 不进指纹)。
	const fingerprint = JSON.stringify({
		catalog: minimal.catalog.files.map((file) => ({
			path: file.path,
			size: file.size,
		})),
		activeEditor: minimal.catalog.activeEditor
			? {
				fileName: minimal.catalog.activeEditor.fileName,
				selection: minimal.catalog.activeEditor.selection,
			}
			: undefined,
		loadedItems: loadedItems.map((item) => ({
			path: item.path,
			contentHash: item.contentHash,
		})),
	});
	const snapshotId = createHash('sha256').update(fingerprint, 'utf8').digest('hex');
	return {
		snapshotId,
		createdAt,
		minimal,
		loadedItems: [...loadedItems],
	};
}
