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

	it('prioritizes named and active files and caps a large workspace directory', () => {
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
		const manifest = buildCompactWorkspaceManifest(workspace, '检查 task_list.cpp');

		assert.strictEqual(manifest.files[0][0], 'task_list.cpp');
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
		const payload = JSON.parse(messages[1].content) as {
			workspacePreview: Array<{ path: string; content: string }>;
			outputContract: Record<string, unknown>;
		};

		assert.strictEqual(payload.workspacePreview[0].path, 'homework/main.cpp');
		assert.match(payload.workspacePreview[0].content, /int main/);
		assert.ok('w' in payload.outputContract);
		assert.ok('r' in payload.outputContract);
		assert.ok('e' in payload.outputContract);
	});
});
