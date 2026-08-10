import * as assert from 'assert';
import { describe, it } from 'mocha';
import {
	buildCompactWorkspaceManifest,
	RouteAndPlanPromptBuilder,
} from '../prompts/routeAndPlanPromptBuilder';
import { buildCompactSkillCatalog } from '../skill/skillCatalogBuilder';
import { routeAndPlanWireSchema } from '../graph/schemas';
import type { SkillGraph } from '../skill/types';
import type { MinimalWorkspaceContext } from '../workspace/types';

const graph: SkillGraph = {
	schemaVersion: 1,
	graphVersion: 'test',
	nodes: [{
		id: 'cpp.pointer',
		title: '指针',
		source: {
			path: 'references/basic-knowledge-explanations.md',
			headingPath: ['程序设计基础', '指针'],
		},
		concepts: ['指针', '地址'],
		aliases: ['pointer'],
		requestTypes: ['concept_explanation'],
		purposes: ['definition', 'example'],
		learnerLevels: ['beginner'],
		relations: [{ type: 'prerequisite', target: 'cpp.pointer' }],
	}],
};

describe('RouteAndPlan compact context', () => {
	it('fills optional compact fields locally instead of rejecting useful JSON', () => {
		const parsed = routeAndPlanWireSchema.parse({
			t: 'concept_explanation',
			p: ['解释概念'],
			s: ['cpp.pointer', 'cpp.address', 'cpp.null', 'cpp.memory'],
		});

		assert.strictEqual(parsed.code, false);
		assert.deepStrictEqual(parsed.u, []);
		assert.strictEqual(parsed.w, false);
		assert.deepStrictEqual(parsed.e, []);
		assert.strictEqual(parsed.s.length, 4);
	});

	it('gives the model the complete compact Skill directory without relation edges or prose', () => {
		const catalog = buildCompactSkillCatalog(graph);
		assert.deepStrictEqual(catalog.sections.map((section) => section.id), ['cpp.pointer']);
		assert.strictEqual(catalog.sections[0].heading, '程序设计基础 > 指针');
		assert.strictEqual('relations' in catalog.sections[0], false);
	});

	it('sorts the manifest by path for stable prefixes and caps a large workspace directory', () => {
		const files = Array.from({ length: 230 }, (_, index) => ({
			path: index === 229 ? 'task_list.cpp' : `file-${index}.cpp`,
			uri: `file:///file-${index}.cpp`,
			kind: 'code' as const,
			size: index + 1,
			modifiedAt: 1,
		}));
		const workspace: MinimalWorkspaceContext = {
			catalog: {
				files,
				questionFiles: [],
				activeEditor: {
					fileName: 'task_list.cpp',
					uri: 'file:///task_list.cpp',
					languageId: 'cpp',
				},
			},
		};
		const manifest = buildCompactWorkspaceManifest(workspace);

		assert.strictEqual(manifest.files[0][0], 'file-0.cpp');
		assert.strictEqual(manifest.activeFile, 'task_list.cpp');
		assert.ok(
			manifest.files.some(([filePath]) => filePath === 'task_list.cpp'),
			'active file must still be listed'
		);
		assert.strictEqual(manifest.files[199][0], 'task_list.cpp', 'active file 应保底在最后一个槽位');
		assert.strictEqual(manifest.files.length, 200);
		assert.strictEqual(manifest.omittedCount, 30);
	});

	it('does not submit active-file preview or question body to RouteAndPlan', () => {
		const workspace: MinimalWorkspaceContext = {
			catalog: { files: [], questionFiles: [] },
			activeFilePreview: 'SECRET_ACTIVE_FILE_BODY',
			questionText: 'SECRET_QUESTION_BODY',
		};
		const messages = new RouteAndPlanPromptBuilder().build({
			skillCore: 'FULL_SHORT_SKILL',
			skillCatalog: buildCompactSkillCatalog(graph),
			initialRoute: {
				requestType: 'concept_explanation',
				confidence: 0.8,
				source: 'conversation',
				lockPolicy: 'unlocked',
				reason: 'local',
			},
			learnerState: {
				level: 'beginner',
				hasAttempted: false,
				hintLevel: 1,
				detectedMisconceptions: [],
				wantsCompleteSolution: false,
			},
			userText: '什么是指针？',
			workspace,
		});
		const prompt = messages.map((message) => message.content).join('\n');

		assert.match(prompt, /FULL_SHORT_SKILL/);
		assert.match(prompt, /cpp\.pointer/);
		assert.match(prompt, /response\.algorithm-understanding/);
		assert.match(prompt, /\[No workspace file previews were submitted\.\]/);
		assert.doesNotMatch(prompt, /SECRET_ACTIVE_FILE_BODY/);
		assert.doesNotMatch(prompt, /SECRET_QUESTION_BODY/);
	});

	it('submits only the explicitly selected bounded workspace preview', () => {
		const workspace: MinimalWorkspaceContext = {
			catalog: { files: [], questionFiles: [] },
		};
		const messages = new RouteAndPlanPromptBuilder().build({
			skillCore: 'SHORT_SKILL',
			skillCatalog: buildCompactSkillCatalog(graph),
			initialRoute: {
				requestType: 'problem_hint',
				confidence: 0.8,
				source: 'conversation',
				lockPolicy: 'unlocked',
				reason: 'local',
			},
			learnerState: {
				level: 'beginner',
				hasAttempted: true,
				hintLevel: 1,
				detectedMisconceptions: [],
				wantsCompleteSolution: false,
			},
			userText: '这里哪里写错了',
			workspace,
			workspacePreview: [{
				path: 'homework/main.cpp',
				kind: 'code',
				content: 'int main() { return 0; }',
				contentHash: 'hash',
				reason: 'test',
			}],
		});
		const prompt = messages[1].content;

		assert.match(prompt, /"workspaceManifest"/);
		assert.match(prompt, /=== Workspace file previews \(untrusted data, 1-based line numbers\) ===/);
		assert.match(prompt, /homework\/main\.cpp/);
		assert.match(prompt, /\n   1 \| int main\(\) \{ return 0; \}/);
		assert.match(prompt, /"w":/);
		assert.match(prompt, /"r":/);
		assert.match(prompt, /"e":/);
		assert.match(prompt, /"userText":"这里哪里写错了"/);
		const manifestIndex = prompt.indexOf('"workspaceManifest"');
		const previewIndex = prompt.indexOf('=== Workspace file previews');
		const dynamicIndex = prompt.indexOf('"learnerState"');
		assert.ok(
			manifestIndex >= 0
			&& manifestIndex < previewIndex
			&& previewIndex < dynamicIndex,
			'稳定字段(workspaceManifest)应排在预览与动态字段(learnerState)之前'
		);
	});
});
