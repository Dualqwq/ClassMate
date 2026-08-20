import * as vscode from 'vscode';
import type { ChatReference } from './types';
import type { LoadedWorkspaceItem } from '../workspace/types';
import type { GraphModelClient } from '../graph/modelClient';
import { AnswerReferencePromptBuilder } from '../prompts/answerReferencePromptBuilder';
import {
	answerReferencesWireSchema,
	parseJsonObject,
	salvageTruncatedReferences,
} from './answerReferenceSchema';
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
 * 解析提取响应:整体解析失败时对截断 JSON 做括号配平抢救,截断前
 * 已完整的条目仍然可用。两种都失败时上抛(由 ChatSession 记
 * reference_extraction_failed),不再静默归零。
 */
export function parseReferenceCandidates(content: string): ExtractedReference[] {
	try {
		return answerReferencesWireSchema.parse(parseJsonObject(content)).r;
	} catch {
		const salvaged = salvageTruncatedReferences(content);
		if (!salvaged) {
			throw new Error(
				`extract_references 响应无法解析且无法抢救: ${content.slice(0, 200)}`
			);
		}
		return salvaged.r;
	}
}

/**
 * 回答完成后的引用提取:粗筛短路 → jsonMode 小调用 → 确定性校验 → 预过滤。
 * 粗筛短路命中时静默返回空;模型调用/解析的失败上抛,由调用方
 * (ChatSession)记录 reference_extraction_failed 后安全降级
 * (回答不受影响,只是没有链接)。
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
	const completion = await options.model.complete(messages, {
		label: 'extract_references',
		temperature: 0,
		// 全文件枚举型回答的提取响应可达 ~1.5k 字符,600 会把 JSON
		// 截断在条目中间(诊断取证 2026-08-20)。
		maxTokens: 2000,
		jsonMode: true,
		thinkingMode: 'disabled',
		signal: options.signal,
	});
	const candidates = parseReferenceCandidates(completion.content);
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
