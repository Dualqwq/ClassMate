// 数据集链式校验(ClassMate测试方法指南.md §3.4):0 错误才允许跑评测。
// 用法: node eval-solution-request/validate-dataset.mjs
import { fileURLToPath } from 'url';
import * as path from 'path';
import * as fs from 'fs';

const root = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(root);
const DATASET_FILES = ['dataset.jsonl'];

const errors = [];
const seenIds = new Set();
let caseCount = 0;
let turnCount = 0;

const VALID_INTENTS = new Set([
	'chat',
	'problem_understanding',
	'problem_hint',
	'concept_explanation',
	'code_explanation',
	'compile_error_help',
	'runtime_error_help',
	'wrong_output_help',
	'oj_failure_help',
	'oop_confusion',
	'mistake_summary',
	'solution_request',
	'code_edit',
	'unclassified',
]);

for (const fileName of DATASET_FILES) {
	const filePath = path.join(root, fileName);
	if (!fs.existsSync(filePath)) {
		errors.push(`${fileName}: 数据集文件不存在`);
		continue;
	}
	const lines = fs.readFileSync(filePath, 'utf8')
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean);
	for (const [index, line] of lines.entries()) {
		const where = `${fileName}:${index + 1}`;
		let entry;
		try {
			entry = JSON.parse(line);
		} catch (error) {
			errors.push(`${where}: JSON 解析失败: ${error.message}`);
			continue;
		}
		caseCount += 1;
		if (!entry.id) {
			errors.push(`${where}: 缺 id`);
		} else if (seenIds.has(entry.id)) {
			errors.push(`${where}: id 重复: ${entry.id}`);
		} else {
			seenIds.add(entry.id);
		}
		if (!entry.workspace) {
			errors.push(`${where} (${entry.id}): 缺 workspace`);
			continue;
		}
		const workspacePath = path.resolve(root, entry.workspace);
		if (!workspacePath.startsWith(repoRoot + path.sep) && workspacePath !== repoRoot) {
			errors.push(`${where} (${entry.id}): workspace 逃逸出评测根目录: ${workspacePath}`);
			continue;
		}
		if (!fs.existsSync(workspacePath)) {
			errors.push(`${where} (${entry.id}): workspace 不存在: ${workspacePath}`);
			continue;
		}
		if (entry.active_file && !fs.existsSync(path.join(workspacePath, entry.active_file))) {
			errors.push(`${where} (${entry.id}): active_file 不存在: ${entry.active_file}`);
		}

		const turns = Array.isArray(entry.turns)
			? entry.turns
			: [{ turn: 1, prompt: entry.prompt, expected_intent: entry.expected_intent }];
		let expectedTurn = 1;
		for (const turn of turns) {
			turnCount += 1;
			const tWhere = `${where} (${entry.id}) turn ${turn.turn}`;
			if (turn.turn !== expectedTurn) {
				errors.push(`${tWhere}: turn 编号不连续,应为 ${expectedTurn}`);
			}
			expectedTurn += 1;
			if (!turn.prompt) {
				errors.push(`${tWhere}: 缺 prompt`);
			}
			if (!turn.expected_intent) {
				errors.push(`${tWhere}: 缺 expected_intent`);
			} else if (!VALID_INTENTS.has(turn.expected_intent)) {
				errors.push(`${tWhere}: expected_intent 不在合法集合内: ${turn.expected_intent}`);
			}
			if (turn.expected_intent === 'solution_request') {
				const text = String(turn.prompt).toLowerCase();
				const asksForComplete = /完整代码|完整实现|完整答案|完整解法|全部.*代码|直接给.*代码|给我.*代码|给我.*解法|solution/.test(text);
				if (!asksForComplete) {
					errors.push(`${tWhere}: expected_intent 为 solution_request,但 prompt 不含完整代码诉求信号`);
				}
			}
		}
	}
}

console.log(`校验用例 ${caseCount} 个、轮次 ${turnCount} 个`);
if (errors.length > 0) {
	for (const error of errors) {
		console.error(`ERROR ${error}`);
	}
	console.error(`共 ${errors.length} 个错误`);
	process.exit(1);
}
console.log('0 错误,允许跑评测');
