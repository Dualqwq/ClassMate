import type { InitialRoute, LearnerState } from '../graph/types';
import type { LLMMessage } from '../llm/types';
import type { CompactSkillCatalog } from '../skill/skillCatalogBuilder';
import type { MinimalWorkspaceContext, WorkspaceFileEntry } from '../workspace/types';

const MAX_WORKSPACE_ENTRIES = 200;

export interface RouteAndPlanPromptInput {
	skillCore: string;
	skillCatalog: CompactSkillCatalog;
	initialRoute: InitialRoute;
	learnerState: LearnerState;
	userText: string;
	workspace: MinimalWorkspaceContext;
}

export interface CompactWorkspaceManifest {
	activeFile?: string;
	files: Array<[path: string, kind: string, size: number]>;
	omittedCount: number;
}

function filePriority(
	file: WorkspaceFileEntry,
	userText: string,
	activeFile?: string
): number {
	const normalizedPath = file.path.toLowerCase().replace(/\\/g, '/');
	const fileName = normalizedPath.split('/').pop() ?? normalizedPath;
	const normalizedText = userText.toLowerCase().replace(/\\/g, '/');
	if (file.path === activeFile) {
		return 0;
	}
	if (fileName && normalizedText.includes(fileName)) {
		return 1;
	}
	if (file.kind === 'question') {
		return 2;
	}
	if (fileName === 'classmate.md') {
		return 3;
	}
	if (file.kind === 'code') {
		return 4;
	}
	return 5;
}

/**
 * 规划阶段只提交文件目录，不提交活动文件预览、题目正文或任意文件正文。
 * 条目按相关性排序并设置硬上限，防止大型工作区目录吞噬输入 Token。
 */
export function buildCompactWorkspaceManifest(
	workspace: MinimalWorkspaceContext,
	userText: string
): CompactWorkspaceManifest {
	const activeFile = workspace.catalog.activeEditor?.fileName;
	const sorted = [...workspace.catalog.files].sort((left, right) => {
		const priority = filePriority(left, userText, activeFile)
			- filePriority(right, userText, activeFile);
		return priority || left.path.localeCompare(right.path);
	});
	const selected = sorted.slice(0, MAX_WORKSPACE_ENTRIES);
	return {
		activeFile,
		files: selected.map((file) => [file.path, file.kind, file.size]),
		omittedCount: Math.max(0, sorted.length - selected.length),
	};
}

export class RouteAndPlanPromptBuilder {
	public build(input: RouteAndPlanPromptInput): LLMMessage[] {
		return [
			{
				role: 'system',
				content: [
					'=== ClassMate RouteAndPlan Mode ===',
					'Return exactly one JSON object. Do not answer the student.',
					'Output the JSON immediately. Do not analyze aloud.',
					'Use only the short keys in the output contract. Keep the whole JSON under 250 tokens. Do not add Markdown or any other keys.',
					input.skillCore,
					'=== Complete compact Skill directory ===',
					JSON.stringify(input.skillCatalog),
				].join('\n\n'),
			},
			{
				role: 'user',
				content: JSON.stringify({
					mode: 'route_and_plan',
					initialRoute: input.initialRoute,
					learnerState: input.learnerState,
					userText: input.userText,
					workspaceManifest: buildCompactWorkspaceManifest(
						input.workspace,
						input.userText
					),
					outputContract: {
						t: 'one allowed request type',
						f: ['0-3 exact paths from workspaceManifest.files'],
						s: ['0-3 exact ids from the Skill directory'],
						d: 'depth 1, 2, 3, or 4',
						p: ['1-4 short answer steps'],
						i: ['0-4 required points'],
						a: ['0-4 forbidden points'],
						code: false,
						q: ['0-6 short concepts'],
						u: ['0-4 of: definition, example, debug, misconception, prerequisite, response_pattern'],
					},
				}),
			},
		];
	}
}
