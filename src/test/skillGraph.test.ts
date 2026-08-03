import * as assert from 'assert';
import * as path from 'path';
import { describe, it } from 'mocha';
import * as vscode from 'vscode';
import { SkillContentLoader } from '../skill/skillContentLoader';
import { SkillGraphLoader } from '../skill/skillGraphLoader';
import { retrieveSkillCandidates } from '../skill/skillGraphRetriever';
import { SkillSectionExtractor } from '../skill/skillSectionExtractor';
import { assembleSkillContext } from '../skill/skillContextAssembler';

describe('V5 Skill graph', () => {
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

	it('indexes every existing data-structure explanation as a retrievable node', async () => {
		const projectRoot = path.resolve(__dirname, '..', '..');
		const skillDir = vscode.Uri.file(path.join(projectRoot, 'skill', 'classmate'));
		const graph = await new SkillGraphLoader(new SkillContentLoader(skillDir)).load();
		const expectedIds = [
			'ds.amortized-analysis',
			'ds.avl-rotations',
			'ds.avl-tree',
			'ds.b-tree',
			'ds.binary-heap',
			'ds.binary-tree-traversal',
			'ds.bitmap',
			'ds.bm',
			'ds.bottom-up-heapify',
			'ds.bracket-matching',
			'ds.bst',
			'ds.comparison-sort-lower-bound',
			'ds.dijkstra',
			'ds.floyd-warshall',
			'ds.graph-bfs-dfs',
			'ds.hash-table',
			'ds.hash-tombstone',
			'ds.histogram-max-rectangle',
			'ds.huffman',
			'ds.interpolation-search',
			'ds.interval-tree',
			'ds.kd-tree',
			'ds.kmp',
			'ds.kruskal',
			'ds.leftist-heap',
			'ds.linked-list-operations',
			'ds.longest-common-subsequence',
			'ds.max-stack-queue',
			'ds.maximum-subarray',
			'ds.maximum-sum-interval',
			'ds.merge-sort',
			'ds.monotonic-stack',
			'ds.prim',
			'ds.quick-sort',
			'ds.recurrence-analysis',
			'ds.red-black-tree',
			'ds.segment-tree',
			'ds.skip-list',
			'ds.sort-stability',
			'ds.splay-tree',
			'ds.topological-sort',
			'ds.union-find',
			'ds.vector-operations',
		];
		const actualIds = graph.nodes
			.map((node) => node.id)
			.filter((id) => id.startsWith('ds.'))
			.sort();
		assert.deepStrictEqual(actualIds, expectedIds);
	});

	it('retrieves data-structure explanations from beginner wording', async () => {
		const projectRoot = path.resolve(__dirname, '..', '..');
		const skillDir = vscode.Uri.file(path.join(projectRoot, 'skill', 'classmate'));
		const graph = await new SkillGraphLoader(new SkillContentLoader(skillDir)).load();
		const cases = [
			['直方图为什么用栈', 'ds.histogram-max-rectangle'],
			['四种旋转记不住', 'ds.avl-rotations'],
			['主串为什么不回退', 'ds.kmp'],
			['删除墓碑', 'ds.hash-tombstone'],
			['三层循环为什么k在外面', 'ds.floyd-warshall'],
			['为什么每次选最小距离', 'ds.dijkstra'],
			['建堆为什么不是nlogn', 'ds.bottom-up-heapify'],
			['pivot到底做什么', 'ds.quick-sort'],
			['为什么可能有多个拓扑序', 'ds.topological-sort'],
			['Prim在维护什么', 'ds.prim'],
			['怎么判断会不会成环', 'ds.kruskal'],
			['路径压缩改了什么', 'ds.union-find'],
			['前中后序有什么用', 'ds.binary-tree-traversal'],
			['删除两个孩子节点', 'ds.bst'],
			['为什么把访问节点转到根', 'ds.splay-tree'],
			['一个节点为什么放很多关键码', 'ds.b-tree'],
			['为什么先分再合', 'ds.merge-sort'],
			['稳定不稳定有什么区别', 'ds.sort-stability'],
			['比较排序为什么不能O(n)', 'ds.comparison-sort-lower-bound'],
			['单调到底在哪里', 'ds.monotonic-stack'],
			['算法没看懂', 'response.algorithm-understanding'],
		] as const;
		for (const [concept, expectedId] of cases) {
			const candidates = retrieveSkillCandidates(graph, {
				requestType: 'concept_explanation',
				concepts: [concept],
				purposes: ['definition', 'example', 'misconception'],
				learnerLevel: 'beginner',
				hintLevel: 1,
				maxSections: 3,
				maxTokens: 1800,
			});
			assert.strictEqual(candidates[0]?.node.id, expectedId, concept);
		}
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
