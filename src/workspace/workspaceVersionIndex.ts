import type { LoadedWorkspaceItem, WorkspaceCatalog } from './types';

/**
 * 整个可加载工作区的内容版本。与"本轮选择了哪些文件"无关:
 * 每个文件记录路径、size、mtime,已加载文件额外记录 contentHash。
 * 两次请求之间用它对比,才能准确说出创建/修改/删除/重命名,
 * 而不是只看加载集合的差集(bug1 修复期的历史教训)。
 */
export interface WorkspaceVersionIndex {
	files: Array<{
		path: string;
		size: number;
		modifiedAt: number;
		contentHash?: string;
	}>;
}

export type WorkspaceChangeKind = 'created' | 'modified' | 'deleted' | 'renamed';

export interface WorkspaceChange {
	kind: WorkspaceChangeKind;
	path: string;
	previousPath?: string;
}

function comparablePath(value: string): string {
	return value.replace(/\\/g, '/').toLocaleLowerCase();
}

export function buildWorkspaceVersionIndex(
	catalog: WorkspaceCatalog,
	loadedItems: LoadedWorkspaceItem[]
): WorkspaceVersionIndex {
	const hashByPath = new Map(
		loadedItems.map((item) => [comparablePath(item.path), item.contentHash])
	);
	return {
		files: catalog.files.map((file) => ({
			path: file.path,
			size: file.size,
			modifiedAt: file.modifiedAt,
			contentHash: hashByPath.get(comparablePath(file.path)),
		})),
	};
}

/**
 * 对比两个版本索引。规则:
 * - 同路径下 hash 不同、或(无 hash 时)size/mtime 变化 → modified;
 * - 只在新版存在 → created;只在旧版存在 → deleted;
 * - 一删一建且两边都有相同 contentHash → 升级为 renamed。
 *   重命名不该被报告成"删了一个文件又建了一个文件",
 *   教学场景里学生重命名文件后模型会误以为工作丢失。
 */
export function diffWorkspaceVersions(
	previous: WorkspaceVersionIndex,
	next: WorkspaceVersionIndex
): WorkspaceChange[] {
	const previousByPath = new Map(
		previous.files.map((file) => [comparablePath(file.path), file])
	);
	const nextByPath = new Map(
		next.files.map((file) => [comparablePath(file.path), file])
	);

	const created: typeof next.files = [];
	const deleted: typeof previous.files = [];
	const changes: WorkspaceChange[] = [];

	for (const file of next.files) {
		const before = previousByPath.get(comparablePath(file.path));
		if (!before) {
			created.push(file);
			continue;
		}
		const changed = before.contentHash !== undefined && file.contentHash !== undefined
			? before.contentHash !== file.contentHash
			: before.size !== file.size || before.modifiedAt !== file.modifiedAt;
		if (changed) {
			changes.push({ kind: 'modified', path: file.path });
		}
	}
	for (const file of previous.files) {
		if (!nextByPath.has(comparablePath(file.path))) {
			deleted.push(file);
		}
	}

	// 一删一建 + 双方 contentHash 相同 → 重命名(取内容不变的最强证据)。
	const deletedByHash = new Map(
		deleted
			.filter((file) => file.contentHash !== undefined)
			.map((file) => [file.contentHash!, file])
	);
	const stillCreated: typeof created = [];
	for (const file of created) {
		const origin = file.contentHash !== undefined
			? deletedByHash.get(file.contentHash)
			: undefined;
		if (origin) {
			changes.push({
				kind: 'renamed',
				path: file.path,
				previousPath: origin.path,
			});
			deletedByHash.delete(file.contentHash!);
		} else {
			stillCreated.push(file);
		}
	}
	const renamedPaths = new Set(
		changes
			.filter((change) => change.kind === 'renamed')
			.map((change) => comparablePath(change.previousPath!))
	);
	for (const file of stillCreated) {
		changes.push({ kind: 'created', path: file.path });
	}
	for (const file of deleted) {
		if (!renamedPaths.has(comparablePath(file.path))) {
			changes.push({ kind: 'deleted', path: file.path });
		}
	}

	changes.sort((a, b) => a.path.localeCompare(b.path));
	return changes;
}
