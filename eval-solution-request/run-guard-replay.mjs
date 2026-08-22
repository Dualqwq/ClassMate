#!/usr/bin/env node
/**
 * run-guard-replay.mjs — #30 solution_request 不代写边界 e2e 回放。
 *
 * 用恶意模型(任何非路由/约束/正确性节点都返回大段完整代码)驱动
 * ClassMateGraphRunner 跑 eval-solution-request/dataset.jsonl 中的每个
 * 单轮/多轮 case,验证:
 *   1. requestType 被冻结为 solution_request;
 *   2. answerPlan.allowCompleteCode 为 false;
 *   3. 模型若直接给完整代码,会被 validate + retry 兜底成 generic_fallback;
 *   4. 最终交付答案不含 ``` 栅栏代码块。
 *
 * 用法: node eval-solution-request/run-guard-replay.mjs
 * 输出: log/solution-request-guard-replay.json
 */
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import * as path from 'path';
import * as fs from 'fs';

const require = createRequire(import.meta.url);
const root = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(root);

const { ClassMateGraphRunner } = require(path.join(repoRoot, 'out', 'graph', 'ClassMateGraphRunner.js'));

const DATASET = path.join(root, 'dataset.jsonl');
const WS = path.join(root, 'ws-solution-request');

const fullProgram = '```cpp\n' + Array.from(
	{ length: 30 },
	(_, index) => `int step${index} = ${index};`
).join('\n') + '\n```';

function readWorkspace() {
	const question = fs.readFileSync(path.join(WS, 'question.md'), 'utf8');
	const main = fs.readFileSync(path.join(WS, 'main.cpp'), 'utf8');
	const catalogFiles = [
		{
			path: 'question.md',
			uri: 'file:///question.md',
			kind: 'question',
			size: Buffer.byteLength(question, 'utf8'),
			modifiedAt: 1,
		},
		{
			path: 'main.cpp',
			uri: 'file:///main.cpp',
			kind: 'code',
			size: Buffer.byteLength(main, 'utf8'),
			modifiedAt: 1,
		},
	];
	return { catalogFiles, contentByPath: { 'question.md': question, 'main.cpp': main } };
}

function buildModel() {
	return {
		async complete(messages) {
			const text = messages.map((message) => message.content).join('\n');
			if (text.includes('ClassMate RouteAndPlan Mode')) {
				return {
					content: JSON.stringify({
						t: 'solution_request',
						m: 'problem_context',
						f: ['main.cpp'],
						s: [],
						d: 1,
						p: ['给出方向', '引导实现'],
						i: [],
						a: ['完整代码'],
						code: false,
						q: ['输入输出'],
						u: ['example'],
						w: true,
						r: null,
						e: ['question.md and main.cpp present'],
					}),
				};
			}
			if (text.includes('ClassMate Problem Constraint Mode')) {
				return { content: JSON.stringify({ h: [], o: [], l: [], e: [], u: [] }) };
			}
			if (text.includes('ClassMate Lightweight Correctness Check')) {
				return { content: JSON.stringify({ p: true, s: 'none', i: [] }) };
			}
			return { content: fullProgram };
		},
	};
}

function buildServices(model, catalogFiles, contentByPath) {
	const graph = {
		schemaVersion: 1,
		graphVersion: 'test',
		nodes: [],
	};
	return {
		model,
		workspaceProvider: {
			getMinimalContext: async () => ({
				catalog: {
					files: catalogFiles,
					questionFiles: ['question.md'],
					activeEditor: {
						fileName: 'main.cpp',
						uri: 'file:///main.cpp',
						languageId: 'cpp',
					},
				},
				questionFile: 'question.md',
			}),
		},
		workspaceLoader: {
			load: async (_catalog, requests) => requests.map((request) => {
				const content = contentByPath[request.target];
				if (content === undefined) {
					throw new Error(`Unexpected load target: ${request.target}`);
				}
				return {
					path: request.target,
					kind: request.target === 'main.cpp' ? 'code' : 'question',
					content,
					contentHash: `${request.target}-hash`,
					reason: 'replay',
				};
			}),
			isItemFresh: () => true,
		},
		skillContentLoader: {
			loadText: async (file) => `content of ${file}`,
		},
		skillGraphLoader: {
			load: async () => graph,
		},
		skillSectionExtractor: {
			extractAll: async () => [],
		},
		problemCardIndexLoader: {
			load: async () => ({ schemaVersion: 1, indexVersion: 'test', cards: [] }),
		},
		problemCardExtractor: {
			extract: async () => { throw new Error('No problem card expected.'); },
		},
		problemCardFactsLoader: {
			select: async () => { throw new Error('No problem facts expected.'); },
		},
	};
}

async function runCase(entry, catalogFiles, contentByPath) {
	const results = [];
	const history = [];
	for (const turn of entry.turns) {
		const model = buildModel();
		const services = buildServices(model, catalogFiles, contentByPath);
		const runner = new ClassMateGraphRunner(services);
		const result = await runner.run({
			requestId: `${entry.id}-turn-${turn.turn}`,
			conversationId: `conversation-${entry.id}`,
			userText: turn.prompt,
			requestSource: 'conversation',
			conversationHistory: history,
		});
		history.push({ role: 'user', content: turn.prompt });
		history.push({ role: 'assistant', content: result.answer });
		results.push({
			turn: turn.turn,
			prompt: turn.prompt,
			expectedIntent: turn.expected_intent,
			actualRequestType: result.state.requestType,
			allowCompleteCode: result.state.answerPlan?.allowCompleteCode,
			answerOutcome: result.state.answerOutcome,
			answer: result.answer,
			hasCodeBlock: result.answer.includes('```'),
		});
	}
	return results;
}

async function main() {
	const { catalogFiles, contentByPath } = readWorkspace();
	const lines = fs.readFileSync(DATASET, 'utf8')
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean);
	const summary = {
		timestamp: new Date().toISOString(),
		totalCases: lines.length,
		passed: 0,
		failed: 0,
		cases: [],
	};
	for (const line of lines) {
		const entry = JSON.parse(line);
		const turns = await runCase(entry, catalogFiles, contentByPath);
		const failedTurns = turns.filter((turn) => {
			if (turn.expectedIntent !== 'solution_request') {
				return false;
			}
			return (
				turn.actualRequestType !== 'solution_request'
				|| turn.allowCompleteCode !== false
				|| turn.answerOutcome !== 'generic_fallback'
				|| turn.hasCodeBlock
			);
		});
		const passed = failedTurns.length === 0;
		if (passed) {
			summary.passed += 1;
		} else {
			summary.failed += 1;
		}
		summary.cases.push({ id: entry.id, passed, turns, failedTurns });
	}

	const logDir = path.join(repoRoot, 'log');
	await fs.promises.mkdir(logDir, { recursive: true });
	const outPath = path.join(logDir, 'solution-request-guard-replay.json');
	await fs.promises.writeFile(outPath, JSON.stringify(summary, null, 2), 'utf8');

	console.log(`\n${summary.passed}/${summary.totalCases} cases passed`);
	for (const caseSummary of summary.cases) {
		const mark = caseSummary.passed ? 'PASS' : 'FAIL';
		console.log(`[${mark}] ${caseSummary.id}`);
	}
	console.log(`明细已写入 ${outPath}`);
	process.exit(summary.failed > 0 ? 1 : 0);
}

await main();
