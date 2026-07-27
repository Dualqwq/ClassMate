import * as assert from 'assert';
import * as path from 'path';
import { describe, it } from 'mocha';
import * as vscode from 'vscode';
import { SkillContentLoader } from '../skill/skillContentLoader';
import { SkillGraphLoader } from '../skill/skillGraphLoader';
import { retrieveSkillCandidates } from '../skill/skillGraphRetriever';
import { SkillSectionExtractor } from '../skill/skillSectionExtractor';
import { assembleSkillContext } from '../skill/skillContextAssembler';

describe('V4 Skill graph', () => {
	it('validates every graph node and extracts every referenced heading', async () => {
		const projectRoot = path.resolve(__dirname, '..', '..');
		const skillDir = vscode.Uri.file(path.join(projectRoot, 'skill', 'classmate'));
		const contentLoader = new SkillContentLoader(skillDir);
		const graph = await new SkillGraphLoader(contentLoader).load();
		const extractor = new SkillSectionExtractor(contentLoader);
		const sections = await extractor.extractAll(graph.nodes.map((node) => ({
			node,
			score: 1,
			matchedBy: ['validation'],
			relationsUsed: [],
		})));
		assert.strictEqual(sections.length, graph.nodes.length);
	});

	it('retrieves pointer sections without submitting the whole reference library', async () => {
		const projectRoot = path.resolve(__dirname, '..', '..');
		const skillDir = vscode.Uri.file(path.join(projectRoot, 'skill', 'classmate'));
		const contentLoader = new SkillContentLoader(skillDir);
		const graph = await new SkillGraphLoader(contentLoader).load();
		const candidates = retrieveSkillCandidates(graph, {
			requestType: 'concept_explanation',
			concepts: ['指针'],
			purposes: ['definition', 'example', 'misconception'],
			learnerLevel: 'beginner',
			hintLevel: 1,
			maxSections: 3,
			maxTokens: 1800,
		});
		const sections = await new SkillSectionExtractor(contentLoader).extractAll(candidates);
		const assembled = assembleSkillContext(sections, 3, 1800);
		assert.ok(assembled.sections.length > 0);
		assert.ok(assembled.sections.length <= 3);
		assert.ok(assembled.sections.some((section) => section.nodeId.includes('pointer')));
		assert.ok(!assembled.content.includes('references/oop.md'));
	});

	it('retrieves linked-list resource-management sections for the real pointer assignment', async () => {
		const projectRoot = path.resolve(__dirname, '..', '..');
		const skillDir = vscode.Uri.file(path.join(projectRoot, 'skill', 'classmate'));
		const contentLoader = new SkillContentLoader(skillDir);
		const graph = await new SkillGraphLoader(contentLoader).load();
		const candidates = retrieveSkillCandidates(graph, {
			requestType: 'runtime_error_help',
			concepts: ['链表', '析构与内存释放', '深拷贝'],
			purposes: ['debug', 'misconception'],
			learnerLevel: 'beginner',
			hintLevel: 1,
			maxSections: 4,
			maxTokens: 2200,
		});
		const ids = candidates.slice(0, 6).map((candidate) => candidate.node.id);
		assert.ok(ids.includes('ds.linked-list-operations'));
		assert.ok(ids.includes('oop.destructor'));
		assert.ok(ids.includes('oop.copy-constructor'));
	});
});
