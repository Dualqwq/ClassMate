import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { describe, after, it } from 'mocha';
import { extractAnswerReferences } from '../chat/answerReferenceExtractor';
import type { GraphModelClient, GraphModelOptions } from '../graph/modelClient';
import type { LLMMessage } from '../llm/types';
import type { LoadedWorkspaceItem } from '../workspace/types';

interface RecordedCall {
	label?: string;
	maxTokens?: number;
	jsonMode?: boolean;
	thinkingMode?: 'enabled' | 'disabled';
}

function makeMockModel(
	content: string
): { model: GraphModelClient; calls: RecordedCall[] } {
	const calls: RecordedCall[] = [];
	return {
		calls,
		model: {
			async complete(_messages: LLMMessage[], options?: GraphModelOptions) {
				calls.push({
					label: options?.label,
					maxTokens: options?.maxTokens,
					jsonMode: options?.jsonMode,
					thinkingMode: options?.thinkingMode,
				});
				return { content };
			},
		},
	};
}

function makeItem(path_: string, content: string): LoadedWorkspaceItem {
	return { path: path_, kind: 'code', content, contentHash: 'h', reason: 'test' };
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'classmate-ref-extract-'));
const tempRootUri = vscode.Uri.file(tempRoot);

async function writeTempFile(name: string, content: string): Promise<void> {
	await vscode.workspace.fs.writeFile(
		vscode.Uri.file(path.join(tempRoot, name)),
		Buffer.from(content, 'utf8')
	);
}

after(() => {
	fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe('extractAnswerReferences', () => {
	it('完整 JSON:生成引用,且提取调用使用提高后的 maxTokens 上限', async () => {
		await writeTempFile('alpha.h', 'void alpha() {}\n');
		await writeTempFile('beta.h', 'void beta() {}\n');
		const { model, calls } = makeMockModel('{"r":[{"f":"alpha.h","s":"alpha"},{"f":"beta.h","s":"beta"}]}');
		const items = [
			makeItem('alpha.h', 'void alpha() {}\n'),
			makeItem('beta.h', 'void beta() {}\n'),
		];
		const references = await extractAnswerReferences(
			'alpha.h 和 beta.h 里分别定义了函数。',
			items,
			{ model, workspaceRoot: tempRootUri }
		);
		assert.strictEqual(calls.length, 1);
		assert.strictEqual(calls[0].label, 'extract_references');
		assert.strictEqual(calls[0].maxTokens, 2000);
		assert.strictEqual(calls[0].jsonMode, true);
		assert.strictEqual(calls[0].thinkingMode, 'disabled');
		assert.strictEqual(references.length, 2);
		assert.strictEqual(references[0].symbol, 'alpha');
		assert.strictEqual(references[1].symbol, 'beta');
	});

	it('截断 JSON:抢救出截断前已完整的条目', async () => {
		await writeTempFile('alpha.h', 'void alpha() {}\n');
		await writeTempFile('beta.h', 'void beta() {}\n');
		const truncated =
			'{"r":[{"f":"alpha.h","s":"alpha"},{"f":"beta.h","s":"beta"},{"f":"alpha.h","s":"ga';
		const { model } = makeMockModel(truncated);
		const items = [
			makeItem('alpha.h', 'void alpha() {}\n'),
			makeItem('beta.h', 'void beta() {}\n'),
		];
		const references = await extractAnswerReferences(
			'alpha.h 与 beta.h 各有一个函数。',
			items,
			{ model, workspaceRoot: tempRootUri }
		);
		assert.strictEqual(references.length, 2);
		assert.strictEqual(references[0].symbol, 'alpha');
		assert.strictEqual(references[1].symbol, 'beta');
	});

	it('无法抢救的响应上抛(由 ChatSession 记 reference_extraction_failed)', async () => {
		await writeTempFile('alpha.h', 'void alpha() {}\n');
		const { model } = makeMockModel('{"r":[{"f":"alpha.h","s":"al');
		const items = [makeItem('alpha.h', 'void alpha() {}\n')];
		await assert.rejects(
			extractAnswerReferences('看 alpha.h 里的实现。', items, {
				model,
				workspaceRoot: tempRootUri,
			})
		);
	});

	it('粗筛短路:回答没有代码提及特征时不发起模型调用', async () => {
		const { model, calls } = makeMockModel('{"r":[]}');
		const items = [makeItem('alpha.h', 'void alpha() {}\n')];
		const references = await extractAnswerReferences('你好,今天天气不错。', items, {
			model,
			workspaceRoot: tempRootUri,
		});
		assert.strictEqual(calls.length, 0);
		assert.deepStrictEqual(references, []);
	});
});
