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
	const fingerprint = JSON.stringify({
		createdAt,
		catalog: minimal.catalog.files.map((file) => ({
			path: file.path,
			size: file.size,
			modifiedAt: file.modifiedAt,
		})),
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
