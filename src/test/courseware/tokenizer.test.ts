import * as assert from 'assert';
import { describe, it } from 'mocha';
import { tokenize, extractWeightedKeywords, extractQueryTerms } from '../../courseware/tokenizer';
import { COURSEWARE_GLOSSARY, COURSEWARE_TERM_ALIASES } from '../../courseware/glossary';

/** 任务要求必须覆盖的测试课件概念。 */
const REQUIRED_GLOSSARY_TERMS = [
	'二叉树', '哈夫曼树', '最短树', '最小生成树', 'mst',
	'邻接矩阵', '道路', '回路', '割集',
	'群', '循环群', '子群', '生成元',
	'树', 'tree', '环', 'cycle', '图', 'graph', '结点', '节点', 'node',
];

describe('统一分词器（设计 §5.1）', () => {
	it('术语表覆盖起步规模与课件必备概念，全部小写', () => {
		assert.ok(COURSEWARE_GLOSSARY.length >= 120);
		for (const term of REQUIRED_GLOSSARY_TERMS) {
			assert.ok(COURSEWARE_GLOSSARY.includes(term), `术语表缺少 ${term}`);
			assert.strictEqual(term, term.toLowerCase());
		}
		for (const group of COURSEWARE_TERM_ALIASES) {
			for (const alias of group) {
				assert.ok(COURSEWARE_GLOSSARY.includes(alias), `别名未进入术语表：${alias}`);
			}
		}
	});

	it('术语表叠加：通用词典拆碎的领域复合词被重组', () => {
		assert.ok(tokenize('二叉树的性质').includes('二叉树'), 'Segmenter 会拆成 二/叉/树');
		assert.ok(tokenize('如何求最小生成树').includes('最小生成树'));
		assert.ok(tokenize('用MST求解最优道路').includes('mst'), '英文别名大小写不敏感');
	});

	it('中英混排：Intl.Segmenter 基线 + 停用词/标点过滤', () => {
		const tokens = tokenize('怎么判断链表有环？Loop!');
		assert.ok(tokens.includes('链表'));
		assert.ok(tokens.includes('环'), '单字 CJK 是真词');
		assert.ok(tokens.includes('loop'));
		assert.ok(!tokens.includes('怎么'), '提问词停用');
		assert.ok(!tokens.includes('？'));
		assert.ok(tokenize('用 DFS 遍历二叉树').includes('dfs'), '英文大写归一为小写');
	});

	it('子串抑制：保留最大覆盖词，删去仍为子串的碎片', () => {
		const keywords = extractWeightedKeywords(undefined, '最小生成树的构造与生成树的应用');
		assert.ok(keywords.includes('最小生成树'));
		assert.ok(!keywords.includes('生成树'), '生成树 ⊂ 最小生成树');
		assert.ok(!keywords.includes('树'), '树 ⊂ 最小生成树');
	});

	it('标题×3 / 正文×1 加权决定 top-N 排序', () => {
		const keywords = extractWeightedKeywords('哈夫曼树', '图 图 图 哈夫曼树', 1);
		assert.deepStrictEqual(keywords, ['哈夫曼树']);
	});
});

describe('期 2 查询侧统一分词（extractQueryTerms）', () => {
	it('中英别名组扩展：命中任一别名即扩展为全组成员', () => {
		const terms = extractQueryTerms('MST 是什么');
		assert.ok(terms.includes('mst'));
		assert.ok(terms.includes('最小生成树'), '英文查询扩展出中文别名');
		assert.ok(terms.includes('最短树'));
	});

	it('反向扩展：中文查询带出英文别名，可命中英文课件', () => {
		const terms = extractQueryTerms('什么是死循环');
		assert.ok(terms.includes('死循环'));
		assert.ok(terms.includes('infinite loop'), '中文查询扩展出英文别名');
		assert.ok(!terms.includes('什么'), '提问词停用');
	});

	it('基础术语双向扩展：Tree/Cycle 与树/环/回路互通', () => {
		const treeFromEnglish = extractQueryTerms('What is a Tree?');
		assert.ok(treeFromEnglish.includes('tree'));
		assert.ok(treeFromEnglish.includes('树'));
		const treeFromChinese = extractQueryTerms('树是什么');
		assert.ok(treeFromChinese.includes('tree'));

		const cycleFromEnglish = extractQueryTerms('How do I find a Cycle?');
		assert.ok(cycleFromEnglish.includes('cycle'));
		assert.ok(cycleFromEnglish.includes('环'));
		assert.ok(cycleFromEnglish.includes('回路'));
		assert.ok(extractQueryTerms('环怎么判断').includes('cycle'));
		assert.ok(extractQueryTerms('回路怎么判断').includes('cycle'));
	});

	it('真实课件基础术语双向扩展：Graph/Node 与图/结点/节点互通', () => {
		const graphFromEnglish = extractQueryTerms('Graph basics');
		assert.ok(graphFromEnglish.includes('图'));
		assert.ok(extractQueryTerms('图的定义').includes('graph'));

		const nodeFromEnglish = extractQueryTerms('What is a Node?');
		assert.ok(nodeFromEnglish.includes('结点'));
		assert.ok(nodeFromEnglish.includes('节点'));
		assert.ok(extractQueryTerms('结点和节点').includes('node'));
	});

	it('最长复合词边界：binary tree/cyclic group/死循环/loop 不串入基础别名组', () => {
		const binaryTree = extractQueryTerms('binary tree');
		assert.ok(binaryTree.includes('二叉树'));
		assert.ok(!binaryTree.includes('tree') && !binaryTree.includes('树'));

		const cyclicGroup = extractQueryTerms('cyclic group');
		assert.ok(cyclicGroup.includes('cyclic group'));
		assert.ok(!cyclicGroup.includes('cycle'));
		assert.ok(!cyclicGroup.includes('环') && !cyclicGroup.includes('回路'));

		const infiniteLoop = extractQueryTerms('死循环');
		assert.ok(infiniteLoop.includes('infinite loop'));
		assert.ok(!infiniteLoop.includes('cycle'));
		assert.ok(!infiniteLoop.includes('环') && !infiniteLoop.includes('回路'));

		const loop = extractQueryTerms('loop');
		assert.ok(loop.includes('loop'));
		assert.ok(!loop.includes('cycle'));
		assert.ok(!loop.includes('环') && !loop.includes('回路'));
	});

	it('废除 n-gram：查询词集不含相邻字组合碎片', () => {
		const terms = extractQueryTerms('如何求最短路径');
		assert.ok(terms.includes('最短路径'));
		assert.ok(terms.includes('shortest path'), '别名组扩展');
		// 旧 n-gram 会产出「如何」「何求」「求最」「路径」等碎片；现只保留真词。
		assert.ok(!terms.includes('如何'), '提问词停用');
		assert.ok(!terms.includes('何求') && !terms.includes('求最'), '相邻字 n-gram 碎片不再产生');
		assert.ok(!terms.includes('路径'), '子串碎片不再是查询词');
	});
});
