import * as vscode from 'vscode';
import type { ChatReference } from './types';
import type { LoadedWorkspaceItem } from '../workspace/types';
import type { GraphModelClient } from '../graph/modelClient';
import { AnswerReferencePromptBuilder } from '../prompts/answerReferencePromptBuilder';
import { answerReferencesWireSchema, parseJsonObject } from './answerReferenceSchema';
import {
	buildReferenceExtractionInput,
	sanitizeAnswerReferences,
	type ExtractedReference,
} from './answerReferenceSanitizer';

const CODE_MENTION_HINT =
	/(?:\.(?:cpp|c|h|hpp|cc|cxx|C|H)\b)|(?:第\s*\d+\s*行)|(?::\s*\d+\b)|(\b[A-Za-z_]\w*\s*\()/;

function hasCodeMentionHint(answer: string): boolean {
	return CODE_MENTION_HINT.test(answer);
}

export function buildAnswerReference(
	ref: ExtractedReference,
	workspaceRoot: vscode.Uri | undefined,
	loadedItems: LoadedWorkspaceItem[]
): ChatReference | undefined {
	const item = loadedItems.find((entry) => entry.path === ref.f);
	if (!item || !workspaceRoot) {
		return undefined;
	}
	const uri = vscode.Uri.joinPath(workspaceRoot, ref.f).toString();
	const label = ref.l !== undefined ? `${ref.f}:${ref.l}` : ref.s ?? ref.f;
	return {
		label,
		uri,
		startLine: ref.l,
		symbol: ref.s,
		kind: ref.t,
	};
}

/** 预过滤:引用文件已不存在的丢弃(避免历史会话出现失效链接)。 */
async function filterExistingReferences(references: ChatReference[]): Promise<ChatReference[]> {
	const result: ChatReference[] = [];
	for (const reference of references) {
		try {
			await vscode.workspace.fs.stat(vscode.Uri.parse(reference.uri));
			result.push(reference);
		} catch {
			// 文件已不存在,丢弃。
		}
	}
	return result;
}

export interface ExtractAnswerReferencesOptions {
	model: GraphModelClient;
	workspaceRoot?: vscode.Uri;
	signal?: AbortSignal;
}

/**
 * 回答完成后的引用提取:粗筛短路 → jsonMode 小调用 → 确定性校验 → 预过滤。
 * 任何一步失败都安全降级为空(不产生链接,不阻断回答)。
 */
export async function extractAnswerReferences(
	answer: string,
	loadedItems: LoadedWorkspaceItem[],
	options: ExtractAnswerReferencesOptions
): Promise<ChatReference[]> {
	const codeItems = loadedItems.filter((item) => item.kind === 'code');
	if (codeItems.length === 0 || !hasCodeMentionHint(answer)) {
		return [];
	}
	const files = buildReferenceExtractionInput(codeItems, answer);
	const messages = new AnswerReferencePromptBuilder().build({ answer, files });
	let candidates: ExtractedReference[] = [];
	try {
		const completion = await options.model.complete(messages, {
			label: 'extract_references',
			temperature: 0,
			maxTokens: 600,
			jsonMode: true,
			thinkingMode: 'disabled',
			signal: options.signal,
		});
		candidates = answerReferencesWireSchema.parse(parseJsonObject(completion.content)).r;
	} catch {
		return [];
	}
	const sanitized = sanitizeAnswerReferences(candidates, codeItems);
	const references: ChatReference[] = [];
	for (const ref of sanitized) {
		const built = buildAnswerReference(ref, options.workspaceRoot, codeItems);
		if (built) {
			references.push(built);
		}
	}
	return filterExistingReferences(references);
}
