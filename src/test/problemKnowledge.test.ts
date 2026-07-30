import * as assert from 'assert';
import * as path from 'path';
import { describe, it } from 'mocha';
import * as vscode from 'vscode';
import { ProblemCardExtractor } from '../problemKnowledge/problemCardExtractor';
import { ProblemCardFactsLoader } from '../problemKnowledge/problemCardFactsLoader';
import { ProblemCardIndexLoader } from '../problemKnowledge/problemCardIndexLoader';
import { retrieveProblemCardCandidates } from '../problemKnowledge/problemCandidateRetriever';
import { assessProblemKnowledgeGate } from '../problemKnowledge/problemKnowledgeGate';
import type { ProblemRecognitionEvidence } from '../problemKnowledge/types';
import { SkillContentLoader } from '../skill/skillContentLoader';

function evidence(
	patch: Partial<ProblemRecognitionEvidence>
): ProblemRecognitionEvidence {
	return {
		fingerprint: 'test',
		userText: '',
		workspacePaths: [],
		focusedPaths: [],
		questionSnippets: [],
		codeMarkers: [],
		loadedContentHashes: [],
		...patch,
	};
}

async function loadRealIndex() {
	const projectRoot = path.resolve(__dirname, '..', '..');
	const skillDir = vscode.Uri.file(path.join(projectRoot, 'skill', 'classmate'));
	const contentLoader = new SkillContentLoader(skillDir);
	const index = await new ProblemCardIndexLoader(contentLoader).load();
	return {
		index,
		extractor: new ProblemCardExtractor(contentLoader),
		factsLoader: new ProblemCardFactsLoader(contentLoader),
	};
}

describe('data-structure problem knowledge', () => {
	it('validates every card id and extracts every referenced Markdown section', async () => {
		const { index, extractor } = await loadRealIndex();
		assert.strictEqual(index.cards.length, 16);
		let extracted = 0;
		for (const card of index.cards) {
			const base = await extractor.extract(card);
			assert.ok(base.content.length > 0);
			extracted++;
			for (const variant of card.variants) {
				const combined = await extractor.extract(card, variant);
				assert.ok(combined.content.includes('候选错误'));
				extracted++;
			}
		}
		assert.strictEqual(extracted, 26);
	});

	it('validates one structured fact entry for every card and variant', async () => {
		const { index, factsLoader } = await loadRealIndex();
		const facts = await factsLoader.load(index);
		assert.strictEqual(facts.entries.length, 26);
		assert.strictEqual(
			new Set(facts.entries.map((entry) => entry.id)).size,
			26
		);

		const risk = await factsLoader.select(index, 'ds.pa2.2-1-2.risk');
		assert.strictEqual(risk.card.complexity?.time, 'O(n log n + T log n)');

		const zuma = await factsLoader.select(
			index,
			'ds.lab2.zuma',
			'ds.lab2.zuma.bug-09-negative-length'
		);
		assert.strictEqual(zuma.variant?.verifiedTests[0].input, 'ABBA\n1\n2 B\n');
		assert.strictEqual(zuma.variant?.verifiedTests[0].expectedOutput, 'AA\n');

		await assert.rejects(
			() => factsLoader.select(
				index,
				'ds.pa1.1-1-1.filename',
				'ds.lab2.zuma.bug-09-negative-length'
			),
			/does not belong to card/
		);
	});

	it('opens the identifier gate for a concrete data-structure assignment', () => {
		const result = assessProblemKnowledgeGate(evidence({
			userText: '这题我没思路',
			activeFile: 'PA1/9489-CST 1-1-1 filename/question.md',
			workspacePaths: ['CST数据结构（2025秋）/PA1/9489-CST 1-1-1 filename/question.md'],
		}));
		assert.strictEqual(result.shouldIdentify, true);
	});

	it('does not open the identifier gate for a generic word from an unrelated course', () => {
		const result = assessProblemKnowledgeGate(evidence({
			userText: 'JavaScript 的 sort 是什么意思？',
			activeFile: 'OOP作业/main.cpp',
			workspacePaths: ['OOP作业/main.cpp'],
		}));
		assert.strictEqual(result.shouldIdentify, false);
	});

	it('opens the identifier gate for the dialog-only Gift statement', () => {
		const result = assessProblemKnowledgeGate(evidence({
			userText: '每份礼物有两个价格，必须选一个，问总价不超过P有多少种选法。n最多40，我只会DFS。',
		}));
		assert.strictEqual(result.shouldIdentify, true);
		assert.ok(result.reasons.includes('data-structure-problem-signal'));
	});

	it('uses indexed titles to open the gate for a direct problem-folder workspace', async () => {
		const { index } = await loadRealIndex();
		const result = assessProblemKnowledgeGate(evidence({
			userText: 'Sect的正统弟子、内力和、引路人把我绕晕了，这几个到底先算哪个？',
			activeFile: 'question.md',
			focusedPaths: ['question.md'],
			workspacePaths: ['question.md'],
			questionSnippets: ['# CST 2-3-2 Sect'],
		}), index.cards);
		assert.strictEqual(result.shouldIdentify, true);
		assert.ok(result.reasons.includes('indexed-problem-identity-signal'));
	});

	it('uses a distinctive indexed alias for a dialog-only Sect question', async () => {
		const { index } = await loadRealIndex();
		const result = assessProblemKnowledgeGate(evidence({
			userText: 'Sect的正统弟子、内力和、引路人把我绕晕了，这几个到底先算哪个？',
		}), index.cards);
		assert.strictEqual(result.shouldIdentify, true);
		assert.ok(result.reasons.includes('indexed-problem-identity-signal'));
	});

	it('retrieves filename from number, title, and distinctive statement evidence', async () => {
		const { index } = await loadRealIndex();
		const candidates = retrieveProblemCardCandidates(index, evidence({
			userText: 'filename这题字符串有五十万，只能插入和删除，二维dp开不下',
			activeFile: 'PA1/9489-CST 1-1-1 filename/question.md',
			workspacePaths: ['PA1/9489-CST 1-1-1 filename/question.md'],
			focusedPaths: ['PA1/9489-CST 1-1-1 filename/question.md'],
			questionSnippets: ['只允许插入和删除，判断距离是否不超过K'],
		}));
		assert.strictEqual(candidates[0].card.id, 'ds.pa1.1-1-1.filename');
		assert.ok(candidates[0].score >= 0.8);
	});

	it('uses an exact code hash to select the corresponding Zuma bug variant', async () => {
		const { index } = await loadRealIndex();
		const candidates = retrieveProblemCardCandidates(index, evidence({
			userText: '这份祖玛代码交上去没过，不知道是WA还是RE',
			activeFile: 'LAB2/Zuma/main.cpp',
			workspacePaths: ['LAB2/Zuma/question.md', 'LAB2/Zuma/main.cpp'],
			focusedPaths: ['LAB2/Zuma/question.md', 'LAB2/Zuma/main.cpp'],
			questionSnippets: ['插入珠子后，三个或更多同色珠子连续时消除'],
			codeMarkers: ['play', 'plen', 'a2p', 'p2a'],
			loadedContentHashes: [
				'8788fac8ffc91ac2c580bd002f23515b53d57ef74bff1f3a9004d239b926ff09',
			],
		}));
		assert.strictEqual(candidates[0].card.id, 'ds.lab2.zuma');
		assert.strictEqual(
			candidates[0].variantScores[0].variant.id,
			'ds.lab2.zuma.bug-06-block-capacity'
		);
		assert.ok(
			candidates[0].variantScores[0].matchedBy.some((item) =>
				item.startsWith('contentHash:'))
		);
	});

	it('does not let unrelated paths in a large course workspace pollute Risk retrieval', async () => {
		const { index } = await loadRealIndex();
		const candidates = retrieveProblemCardCandidates(index, evidence({
			userText: 'Risk这题每天往前看的范围都不一样，Max Queue到底要怎么用？',
			activeFile: 'PA2/9513-CST 2-1-2 Risk/question.md',
			questionFile: 'PA2/9513-CST 2-1-2 Risk/question.md',
			focusedPaths: ['PA2/9513-CST 2-1-2 Risk/question.md'],
			workspacePaths: [
				'PA1/9489-CST 1-1-1 filename/question.md',
				'PA2/9513-CST 2-1-2 Risk/question.md',
				'LAB2/Zuma/question.md',
			],
			questionSnippets: ['# CST 2-1-2 Risk', '每天往前看的范围'],
		}));
		assert.strictEqual(candidates[0].card.id, 'ds.pa2.2-1-2.risk');
		assert.ok(candidates[0].score > candidates[1].score);
	});
});
