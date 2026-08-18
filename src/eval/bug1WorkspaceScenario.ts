import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import type { Bug1DatasetMutation } from './bug1Review';

export interface Bug1AppliedMutation extends Bug1DatasetMutation {
	beforeContent: string;
	afterContent: string;
	beforeHash: string;
	afterHash: string;
}

export interface Bug1WorkspaceScenario {
	apply(mutations: Bug1DatasetMutation[]): Promise<Bug1AppliedMutation[]>;
	restore(): Promise<void>;
}

function sha256(content: string): string {
	return createHash('sha256').update(content, 'utf8').digest('hex');
}

function resolveWorkspaceFile(workspacePath: string, file: string): string {
	const root = path.resolve(workspacePath);
	const target = path.resolve(root, file);
	if (target === root || !target.startsWith(`${root}${path.sep}`)) {
		throw new Error(`Mutation target escapes the workspace: ${file}`);
	}
	return target;
}

export async function openBug1WorkspaceScenario(
	workspacePath: string
): Promise<Bug1WorkspaceScenario> {
	const originals = new Map<string, string>();
	let restored = false;
	return {
		async apply(mutations): Promise<Bug1AppliedMutation[]> {
			if (restored) {
				throw new Error('Workspace scenario has already been restored.');
			}
			const applied: Bug1AppliedMutation[] = [];
			for (const mutation of mutations) {
				const target = resolveWorkspaceFile(workspacePath, mutation.file);
				const beforeContent = await fs.readFile(target, 'utf8');
				if (!mutation.replace.from) {
					throw new Error(`Mutation ${mutation.file}: from-string must not be empty.`);
				}
				if (!beforeContent.includes(mutation.replace.from)) {
					throw new Error(
						`Mutation ${mutation.file}: from-string not found in current content.`
					);
				}
				if (!originals.has(target)) {
					originals.set(target, beforeContent);
				}
				const afterContent = beforeContent.replace(
					mutation.replace.from,
					mutation.replace.to
				);
				await fs.writeFile(target, afterContent, 'utf8');
				applied.push({
					...mutation,
					beforeContent,
					afterContent,
					beforeHash: sha256(beforeContent),
					afterHash: sha256(afterContent),
				});
			}
			return applied;
		},
		async restore(): Promise<void> {
			if (restored) {
				return;
			}
			restored = true;
			await Promise.all(
				[...originals.entries()].map(([target, content]) =>
					fs.writeFile(target, content, 'utf8')
				)
			);
		},
	};
}
