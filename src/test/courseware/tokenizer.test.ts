import * as assert from 'assert';
import { describe, it } from 'mocha';
import { tokenize, extractWeightedKeywords } from '../../courseware/tokenizer';
import { COURSEWARE_GLOSSARY } from '../../courseware/glossary';

/** 任务要求必须覆盖的测试课件概念。 */
const REQUIRED_GLOSSARY_TERMS = [
	'二叉树', '哈夫曼树', '最短树', '最小生成树', 'mst',
	'邻接矩阵', '道路', '回路', '割集',
	'群', '循环群', '子群', '生成元',
];

describe('统一分词器（设计 §5.1）', () => {
	it('术语表覆盖起步规模与课件必备概念，全部小写', () => {
		assert.ok(COURSEWARE_GLOSSARY.length >= 120);
		for (const term of REQUIRED_GLOSSARY_TERMS) {
			assert.ok(COURSEWARE_GLOSSARY.includes(term), `术语表缺少 ${term}`);
			assert.strictEqual(term, term.toLowerCase());
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
