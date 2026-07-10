import * as vscode from 'vscode';
import type { LLMMessage } from '../llm/types';
import type { MessageIntent } from '../chat/types';
import { PromptLoader } from './promptLoader';
import { classifyRequest, RequestType } from './intentRouter';

/**
 * Builds the system prompt for a ClassMate request by loading the relevant
 * skill files and ordering them so stable content can be cached.
 *
 * The builder is intentionally provider-agnostic: it returns plain
 * `{ role: 'system', content: string }` messages. ClaudeAdapter will place
 * `cache_control` on the last system block; other adapters simply concatenate
 * the content or pass it as `system` messages.
 */
export class SystemPromptBuilder {
	private readonly _loader: PromptLoader;
	private readonly _skillDir: vscode.Uri;

	constructor(loader: PromptLoader, skillDir: vscode.Uri) {
		this._loader = loader;
		this._skillDir = skillDir;
	}

	/**
	 * Build system messages for the given intent + user text.
	 *
	 * Order matters: static identity/teaching strategy blocks come first and
	 * get `cache_control` (applied by ClaudeAdapter on the last block). Dynamic
	 * reference files come after the breakpoint.
	 */
	public async build(
		frontendIntent: MessageIntent | undefined,
		userText: string
	): Promise<LLMMessage[]> {
		const requestType = classifyRequest(frontendIntent, userText);

		// Static identity + pedagogy blocks (cacheable).
		const [skill, pedagogy] = await this._loader.loadAll(this._skillDir, [
			'SKILL.md',
			'references/pedagogy.md',
		]);

		const messages: LLMMessage[] = [
			{ role: 'system', content: skill },
			{ role: 'system', content: this._buildPedagogyPrompt(pedagogy, requestType) },
		];

		// Dynamic reference blocks (not cached).
		const references = this._selectReferences(requestType, userText);
		if (references.length > 0) {
			const contents = await this._loader.loadAll(this._skillDir, references);
			for (const content of contents) {
				messages.push({ role: 'system', content });
			}
		}

		// Remind the model of the request type so it follows the right workflow.
		messages.push({
			role: 'system',
			content: `Request classification: ${requestType}. Follow the matching workflow from SKILL.md.`,
		});

		return messages;
	}

	private _buildPedagogyPrompt(pedagogy: string, requestType: RequestType): string {
		return [
			'=== Teaching configuration ===',
			`Primary request type for this turn: ${requestType}`,
			'',
			pedagogy,
		].join('\n');
	}

	private _selectReferences(requestType: RequestType, userText: string): string[] {
		const references: string[] = [];
		const text = userText.toLowerCase();

		// Error/debug contexts benefit from the error guide and response patterns.
		if (
			requestType === 'compile_error_help' ||
			requestType === 'runtime_error_help' ||
			requestType === 'wrong_output_help' ||
			requestType === 'oj_failure_help'
		) {
			references.push('references/cpp-error-guide.md');
			references.push('references/response-patterns.md');
		}

		// Concept and OOP confusion contexts benefit from the knowledge map.
		if (
			requestType === 'concept_explanation' ||
			requestType === 'oop_confusion' ||
			looksLikeConceptQuestion(text)
		) {
			references.push('references/knowledge-map.md');
		}

		// Structured responses (explanations, hints, summaries) use response patterns.
		if (
			requestType === 'code_explanation' ||
			requestType === 'concept_explanation' ||
			requestType === 'problem_hint' ||
			requestType === 'mistake_summary'
		) {
			references.push('references/response-patterns.md');
		}

		// If the text mentions common confusion keywords, load the misconception bank.
		if (looksLikeMisconception(text) || requestType === 'oop_confusion') {
			references.push('references/misconception-bank.md');
		}

		return [...new Set(references)];
	}
}

function looksLikeConceptQuestion(text: string): boolean {
	return (
		text.includes('什么是') ||
		text.includes('什么叫') ||
		text.includes('解释一下') ||
		text.includes('给我讲讲') ||
		text.includes('讲讲') ||
		text.includes('介绍一下') ||
		text.includes('概念')
	);
}

function looksLikeMisconception(text: string): boolean {
	return (
		text.includes('为什么') ||
		text.includes('难道不是') ||
		text.includes('我以为') ||
		text.includes('混淆') ||
		text.includes('区别') ||
		text.includes('不同') ||
		text.includes('一样吗')
	);
}
