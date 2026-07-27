import * as vscode from 'vscode';
import type { LLMMessage } from '../llm/types';
import type { MessageIntent } from '../chat/types';
import { PromptLoader } from './promptLoader';

import type { WorkspaceContextProvider } from '../workspace/workspaceContextProvider';
import type { WorkspaceContext } from '../workspace/types';

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
	private readonly _workspaceProvider: WorkspaceContextProvider;

	constructor(loader: PromptLoader, skillDir: vscode.Uri, workspaceProvider: WorkspaceContextProvider) {
		this._loader = loader;
		this._skillDir = skillDir;
		this._workspaceProvider = workspaceProvider;
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
		_userText: string
	): Promise<LLMMessage[]> {
		// Keep the instructional prefix identical between turns so DeepSeek can
		// reuse it as a prompt-cache prefix. Request-specific routing is already
		// described by SKILL.md and can be inferred from the current user turn.
		const [skill, pedagogy, ...references] = await this._loader.loadAll(this._skillDir, [
			'SKILL.md',
			'references/pedagogy.md',
			'references/cpp-error-guide.md',
			'references/response-patterns.md',
			'references/knowledge-map.md',
			'references/misconception-bank.md',
		]);

		const messages: LLMMessage[] = [
			{ role: 'system', content: skill },
			{ role: 'system', content: this._buildPedagogyPrompt(pedagogy) },
			...references.map((content) => ({ role: 'system' as const, content })),
		];

		// Dynamic workspace context (not cached).
		// Refresh at request time so an edit immediately followed by Send cannot
		// race the editor-change watcher and produce stale source/selection data.
		const workspaceContext = await this._workspaceProvider.refresh();
		const workspacePrompt = this._buildWorkspaceContextPrompt(workspaceContext);
		if (workspacePrompt) {
			messages.push({ role: 'system', content: workspacePrompt });
		}
		if (frontendIntent === 'code_edit') {
			messages.push({
				role: 'system',
				content: [
					'The user requested a code edit.',
					'Return a concise explanation followed by exactly one fenced code block containing the complete replacement content of the active file.',
					'Do not omit unchanged sections and do not use ellipses or partial snippets.',
				].join(' '),
			});
		}

		return messages;
	}

	private _buildWorkspaceContextPrompt(context: WorkspaceContext): string | undefined {
		const parts: string[] = ['=== Current project context ==='];
		let hasContent = false;

		if (context.cppFiles.length > 0) {
			parts.push(`Source files: ${context.cppFiles.join(', ')}`);
			hasContent = true;
		}

		if (context.codeDocuments.length > 0) {
			parts.push('');
			parts.push('--- Complete workspace code snapshot ---');
			for (const document of context.codeDocuments) {
				parts.push(`File: ${document.fileName} (${document.languageId})`);
				parts.push(`\`\`\`${document.languageId}`);
				parts.push(document.content);
				parts.push('```');
			}
			hasContent = true;
		}

		if (context.codeChanges.length > 0) {
			parts.push('');
			parts.push('--- Code change timeline (current extension session) ---');
			for (const change of context.codeChanges) {
				const position = change.startLine !== undefined
					? ` at ${change.startLine}:${change.startColumn}-${change.endLine}:${change.endColumn}`
					: '';
				parts.push(`[${new Date(change.timestamp).toISOString()}] ${change.kind} ${change.fileName}${position}`);
				if (change.insertedText !== undefined) {
					parts.push(`Inserted text: ${JSON.stringify(change.insertedText)}`);
				}
				if (change.removedLength !== undefined) {
					parts.push(`Removed characters: ${change.removedLength}`);
				}
			}
			hasContent = true;
		}

		if (context.questionText) {
			parts.push('');
			parts.push(`--- Problem description${context.questionFile ? ` (${context.questionFile})` : ''} ---`);
			parts.push(context.questionText);
			hasContent = true;
		}

		if (context.activeEditor) {
			const editor = context.activeEditor;
			parts.push('');
			parts.push('--- Active editor ---');
			parts.push(`File: ${editor.fileName}`);
			parts.push(`Language: ${editor.languageId}`);
			if (editor.selection) {
				parts.push('Selected text:');
				parts.push(editor.selection);
			}
			if (context.codeDocuments.some((document) => document.fileName === editor.fileName)) {
				parts.push('The full current file content is included in the workspace code snapshot above.');
			} else {
				parts.push('Current file content:');
				parts.push(editor.content);
			}
			hasContent = true;
		}

		if (context.courseContext) {
			const cc = context.courseContext;
			parts.push('');
			parts.push('--- Course context ---');
			if (cc.course) {
				parts.push(`Course: ${cc.course}`);
			}
			if (cc.currentConcept) {
				parts.push(`Current concept: ${cc.currentConcept}`);
			}
			if (cc.prerequisites.length > 0) {
				parts.push(`Prerequisites: [${cc.prerequisites.join(', ')}]`);
			}
			if (cc.teachingStrategy) {
				parts.push(`Teaching strategy: ${cc.teachingStrategy}`);
			}
			if (cc.body) {
				parts.push('');
				parts.push(cc.body);
			}
			hasContent = true;
		}

		if (!hasContent) {
			return undefined;
		}

		return parts.join('\n');
	}

	private _buildPedagogyPrompt(pedagogy: string): string {
		return [
			'=== Teaching configuration ===',
			'',
			pedagogy,
		].join('\n');
	}
}
