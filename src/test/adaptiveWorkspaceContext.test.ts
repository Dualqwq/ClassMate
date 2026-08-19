import * as assert from 'assert';
import { describe, it } from 'mocha';
import {
	estimateTokens,
	selectFirstCallWorkspaceRequests,
} from '../workspace/contextPolicy';
import { buildWorkspaceStructureMap } from '../workspace/workspaceStructureMap';
import { AnswerPromptBuilder } from '../prompts/answerPromptBuilder';
import type { AnswerPlan } from '../graph/types';
import type {
	LoadedWorkspaceItem,
	MinimalWorkspaceContext,
	WorkspaceContextSnapshot,
} from '../workspace/types';

function entry(path: string, size: number) {
	return {
		path,
		uri: `file:///w/${path}`,
		kind: 'code' as const,
		size,
		modifiedAt: 1,
	};
}

function workspaceOf(paths: Array<[string, number]>, activeFile?: string): MinimalWorkspaceContext {
	return {
		catalog: {
			files: paths.map(([path, size]) => entry(path, size)),
			questionFiles: [],
			...(activeFile
				? {
					activeEditor: {
						fileName: activeFile,
						uri: `file:///w/${activeFile}`,
						languageId: 'cpp',
					},
				}
				: {}),
		},
	};
}

describe('adaptive workspace context', () => {
	it('estimates tokens deterministically and weighs CJK above ASCII', () => {
		const ascii = 'abcdefgh'; // 8 ASCII chars
		const cjk = '八个中文字符'; // 6 CJK chars
		assert.strictEqual(estimateTokens(ascii), estimateTokens(ascii));
		assert.ok(estimateTokens(ascii) > 0);
		// 每个 CJK 字符的 token 权重必须高于每个 ASCII 字符,
		// 否则中文题面/回答的预算会被明显低估。
		const asciiPerChar = estimateTokens(ascii) / ascii.length;
		const cjkPerChar = estimateTokens(cjk) / cjk.length;
		assert.ok(cjkPerChar > asciiPerChar);
	});

	it('does not full-load a workspace that fits the file count but exceeds the token budget', () => {
	 // 18 个文件(低于 20 文件上限),每个 30 KiB:总 token 估算超预算,
	 // 必须走"最小正文集合"路径而不是全传。
		const files = Array.from({ length: 18 }, (_, index) =>
			[`src/file-${index}.cpp`, 30 * 1024] as [string, number]);
		const requests = selectFirstCallWorkspaceRequests(
			workspaceOf(files, 'src/file-0.cpp'),
			undefined
		);
		const targets = requests.map((request) => request.target);
		assert.ok(!targets.includes('src/file-17.cpp'), '超出 token 预算的文件不应全传');
		assert.ok(targets.includes('src/file-0.cpp'), '活动文件必须保留');
	});

	it('builds a symbol structure map for code files only', async () => {
		const map = await buildWorkspaceStructureMap([
			{
				path: 'monster.h',
				kind: 'code',
				content: 'class Monster\n{\n    void takeTurn(Player &p)\n    {\n        p.takeDamage(1);\n    }\n};\n',
			},
			{
				path: 'Makefile',
				kind: 'build',
				content: 'app: main.cpp\n\tg++ main.cpp -o app\n',
			},
		]);

		assert.strictEqual(map.length, 1);
		assert.strictEqual(map[0].path, 'monster.h');
		const names = map[0].symbols.map((symbol) => symbol.name);
		assert.ok(names.includes('Monster'));
		assert.ok(names.includes('takeTurn'));
	});

	it('caps the number of structure map files to bound parsing cost', async () => {
		const files = Array.from({ length: 120 }, (_, index) => ({
			path: `file-${index}.cpp`,
			kind: 'code' as const,
			content: 'int f() { return 1; }\n',
		}));
		const map = await buildWorkspaceStructureMap(files);
		assert.ok(map.length <= 80, `结构图文件数必须受限,实际 ${map.length}`);
	});

	it('places question-adjacent evidence immediately before the user question', () => {
		const activeContent = 'class Monster\n{\n    void takeTurn() {}\n};\n';
		const minimal = workspaceOf([['monster.h', activeContent.length]], 'monster.h');
		const loadedItems: LoadedWorkspaceItem[] = [{
			path: 'monster.h',
			kind: 'code',
			content: activeContent,
			contentHash: 'hash',
			reason: 'active file',
		}];
		const snapshot: WorkspaceContextSnapshot = {
			snapshotId: 'snap',
			createdAt: 1,
			minimal,
			loadedItems,
		};
		const plan = {
			requestType: 'code_edit',
			depthLevel: 1,
			responsePattern: ['定位'],
			mustInclude: [],
			mustAvoid: ['完整代码'],
			allowCompleteCode: false,
			concepts: ['takeTurn'],
			skillQueries: ['cpp.function'],
		} as unknown as AnswerPlan;
		const messages = new AnswerPromptBuilder().build({
			skillCore: 'skill',
			pedagogy: 'pedagogy',
			answerPlan: plan,
			assembledSkillContext: 'skill-context',
			workspaceSnapshot: snapshot,
			userText: '现在 monster.h 要怎么改',
			conversationHistory: [
				{ role: 'user', content: '上一轮问题' },
				{ role: 'assistant', content: '上一轮回答' },
			],
		});

		const last = messages[messages.length - 1];
		assert.strictEqual(last.role, 'user');
		assert.strictEqual(last.content, '现在 monster.h 要怎么改');
		const adjacent = messages[messages.length - 2];
		assert.ok(
			adjacent.role === 'system' && adjacent.content.includes('Question-adjacent evidence'),
			'紧贴问题的必须是问题相邻证据块'
		);
		assert.ok(adjacent.content.includes('takeTurn'));
	});

	it('omits the question-adjacent block when no relevant file is loaded', () => {
		const minimal = workspaceOf([]);
		const snapshot: WorkspaceContextSnapshot = {
			snapshotId: 'snap',
			createdAt: 1,
			minimal,
			loadedItems: [],
		};
		const plan = {
			requestType: 'concept_explanation',
			depthLevel: 1,
			responsePattern: ['解释'],
			mustInclude: [],
			mustAvoid: [],
			allowCompleteCode: false,
			concepts: ['指针'],
			skillQueries: ['cpp.pointer'],
		} as unknown as AnswerPlan;
		const messages = new AnswerPromptBuilder().build({
			skillCore: 'skill',
			pedagogy: 'pedagogy',
			answerPlan: plan,
			assembledSkillContext: 'skill-context',
			workspaceSnapshot: snapshot,
			userText: '什么是指针',
			conversationHistory: [],
		});

		const adjacent = messages[messages.length - 2];
		assert.ok(
			!(adjacent.role === 'system' && adjacent.content.includes('Question-adjacent evidence')),
			'无相关文件时不应插入证据块'
		);
	});
});
