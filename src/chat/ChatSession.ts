import { formatDebugLog, formatRawDebugLog } from './debugLogFormatter';
import { parseDebugCommand, resolveDebugOutputPath } from './debugCommand';
import type { DebugEventIndex } from '../debug/debugJourneyStore';
import * as vscode from 'vscode';
import * as path from 'path';
import { mkdir } from 'fs/promises';
import type { ChatAttachment, ChatImage, ChatMessage, ChatReference, ChatState, ExtensionToWebviewMessage, LLMConfig, LLMProvider, MessageIntent, PersistedChatConversation, PersistedChatData, ProposedCodeEdit, WebviewPresenter, WebviewToExtensionMessage } from './types';
import type { LLMAdapter, LLMRequest, LLMStreamCallbacks, LLMTokenUsage } from '../llm/types';
import type { SystemPromptBuilder } from '../prompts/systemPromptBuilder';
import { buildJourneySummary, type JourneySummary } from '../debug/debugJourneySummary';
import { DebugJourneyStore } from '../debug/debugJourneyStore';
import type { HintRequestedEvent } from '../debug/types';
import { buildKnowledgeCards } from '../debug/knowledgeCardBuilder';
import type { KnowledgeCard } from '../debug/knowledgeCard';
import { formatFixAsDiff } from '../debug/formatDiff';
import { ClaudeAdapter } from '../llm/ClaudeAdapter';
import { OpenAIAdapter } from '../llm/OpenAIAdapter';
import { DeepSeekAdapter } from '../llm/DeepSeekAdapter';
import { getApiKey } from '../config/apiKey';
import { extractPdfBuffer, formatPdfExtraction } from '../workspace/pdfExtractor';
import {
	ClassMateGraphRunner,
	type ClassMateGraphServices,
} from '../graph/ClassMateGraphRunner';
import type { ConversationWorkspaceContext } from '../graph/types';
import { AdapterGraphModelClient, FallbackGraphModelClient } from '../graph/modelClient';
import type { GraphModelClient } from '../graph/modelClient';
import type { GraphModelTrace } from '../graph/modelClient';
import { addTokenUsage } from '../llm/tokenUsage';
import { looksLikeCodeEditRequest } from './codeEditIntent';
import type { LoadedWorkspaceItem } from '../workspace/types';
import {
	buildReferenceExtractionInput,
	stripContractNotation,
	type ReferenceExtractionFile,
} from './answerReferenceSanitizer';
import { extractAnswerReferences } from './answerReferenceExtractor';
import { mergeContractAndExtractedReferences } from './answerReferenceMerge';
import type { ConversationDiagnosticBundle } from './conversationDiagnostics';
import { ConversationDiagnosticRecorder } from './conversationDiagnostics';
import { showTextDocumentRespectingPanels } from '../ui/panelGrouping';

const HINT_INTENTS: MessageIntent[] = [
	'hint',
	'code_explanation',
	'concept_explanation',
	'error_explanation',
	'debug_suggestion',
	'summary',
];

function createConversationId(): string {
	return `conversation-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export class ChatSession {
	private static _instance: ChatSession | undefined;

	private _state: ChatState = {
		messages: [],
		inputDraft: '',
		isStreaming: false,
		currentStreamMessageId: null,
		processingStage: null,
		activeConversationId: createConversationId(),
		conversations: [],
	};
	private readonly _conversationRecords = new Map<string, PersistedChatConversation>();
	private _onPersist?: (data: PersistedChatData) => Thenable<void>;
	private _referenceProvider?: () => ChatReference[];
	private _onOpenReference?: (reference: ChatReference) => void;

	private _presenters: Set<WebviewPresenter> = new Set();

	private _onIntent?: (intent: MessageIntent) => void;
	private _onRequestLLMConfig?: () => Promise<LLMConfig>;
	private _onSaveLLMConfig?: (provider: string, model: string, apiKey?: string, apiUrl?: string) => void;
	private _onSaveFallbackLLMConfig?: (input: {
		provider: LLMProvider;
		model: string;
		apiKey?: string;
		apiUrl?: string;
	} | null) => void;
	private _onGetApiKey?: () => Promise<string | undefined>;
	private _llmConfig?: LLMConfig;
	private _currentAdapter?: LLMAdapter;
	/** 7.8 恢复通道:显式配置的备用 provider;未配置时为 undefined。 */
	private _fallbackLLMConfig?: LLMConfig;
	private _onGetFallbackApiKey?: () => Promise<string | undefined>;
	private _promptBuilder?: SystemPromptBuilder;
	private _graphServices?: Omit<ClassMateGraphServices, 'model' | 'signal'>;
	private _onPerformanceTrace?: (event: string, data: unknown) => void;
	private _graphAbortController?: AbortController;
	private readonly _conversationWorkspaceContexts =
		new Map<string, ConversationWorkspaceContext>();
	private _debugStore?: DebugJourneyStore;
	private _sessionId?: string;
	private _workspaceId?: string;
	/** //show-usage:最近一次图流程里各节点的模型用量(保留 undefined 以便判断 provider 是否上报缓存字段)。 */
	private _lastUsageDebug?: {
		total: LLMTokenUsage | undefined;
		byNode: Record<string, LLMTokenUsage>;
	};
	/** //show-prompts:最近一次图流程里各节点真实发送给模型的完整提示词(按 label 覆盖保存)。 */
	private _lastPromptsDebug: Record<string, LLMRequest['messages']> = {};
	/** 调试输出文件的固定落点(开发态为项目根下的 log,由 extension.ts 注入),不随工作区变化。 */
	private _debugOutputDir?: string;
	private _diagnosticRecorder?: ConversationDiagnosticRecorder;
	private _diagnosticMetadata?: {
		extensionVersion: string;
		workspaceFolders: string[];
	};

	private async _buildKnowledgeCardsContent(): Promise<string> {
		if (!this._debugStore) {
			return 'Debug store is not initialized.';
		}

		const cards = await buildKnowledgeCards(this._debugStore);
		if (cards.length === 0) {
			return '=== DEBUG: Knowledge cards ===\n\nNo knowledge cards available yet. Compile some code and come back!';
		}

		const lines: string[] = [
			'=== DEBUG: Knowledge cards ===',
			`workspaceId: ${this._debugStore.workspaceId}`,
			`total cards: ${cards.length}`,
			'',
		];

		for (const card of cards) {
			lines.push(`## ${card.title} (${card.tag})`);
			lines.push(`**Summary:** ${card.summary}`);
			lines.push('');
			lines.push('**Common causes:**');
			for (const cause of card.commonCauses) {
				lines.push(`- ${cause}`);
			}
			lines.push('');
			lines.push('**Suggested fixes:**');
			for (const fix of card.suggestedFixes) {
				lines.push(`- ${fix}`);
			}
			lines.push('');
			lines.push(`**Check method:** ${card.checkMethod}`);
			lines.push('');
			lines.push('**Wrong example:**');
			lines.push('```cpp');
			lines.push(card.wrongExample);
			lines.push('```');
			lines.push('');
			lines.push('**Correct example:**');
			lines.push('```cpp');
			lines.push(card.correctExample);
			lines.push('```');
			if (card.concreteFixes.length > 0) {
				lines.push('');
				lines.push('**Concrete fixes from your edits:**');
				for (let i = 0; i < card.concreteFixes.length; i++) {
					const fix = card.concreteFixes[i];
					lines.push('');
					lines.push(`Fix ${i + 1}:`);
					lines.push('```diff');
					lines.push(fix.diff);
					lines.push('```');
				}
			}
			lines.push('');
			lines.push(
				`Stats: frequency=${card.frequency}, resolved=${card.resolvedCount}, ` +
				`unresolved=${card.unresolvedCount}, avgFixAttempts=${card.avgFixAttempts.toFixed(2)}`
			);
			lines.push('');
		}

		return lines.join('\n');
	}

	private async _insertKnowledgeCards(userText: string, filePath?: string): Promise<void> {
		const content = await this._buildKnowledgeCardsContent();
		const message: ChatMessage = {
			id: this._generateId(),
			role: 'system',
			content,
			intent: undefined,
			isKnowledgeCards: true,
			timestamp: Date.now(),
		};

		await this._emitDebugMessage(message, filePath);
	}

	private async _buildDebugJourneyContent(): Promise<string> {
		if (!this._debugStore) {
			return 'Debug store is not initialized.';
		}

		const summary = await buildJourneySummary(this._debugStore);

		const resolvedWithEdit = summary.lifecycles
			.filter((l) => l.resolvedAt && l.resolvingEditId)
			.slice(0, 3);
		const allEvents = await this._debugStore.getEvents();

		const lines: string[] = [
			'=== DEBUG: Debug Journey summary ===',
			`workspaceId: ${summary.workspaceId}`,
			`total events: ${summary.totalEvents}`,
			'',
			'--- Compile outcomes ---',
			`compile errors: ${summary.errorStats.totalCompileErrors}`,
			`compile successes: ${summary.errorStats.totalCompileSuccesses}`,
			`run errors: ${summary.errorStats.totalRunErrors}`,
			'',
			'--- Error lifecycle ---',
			`tracked lifecycles: ${summary.lifecycles.length}`,
			`resolved: ${summary.lifecycles.filter((l) => l.resolvedAt).length}`,
			`unresolved: ${summary.lifecycles.filter((l) => !l.resolvedAt).length}`,
			`avg fix attempts: ${summary.metrics.avgFixAttempts.toFixed(2)}`,
			'',
			'--- Top knowledge tags ---',
			...Object.entries(summary.errorStats.byKnowledgeTag)
				.sort((a, b) => b[1] - a[1])
				.slice(0, 5)
				.map(([tag, count]) => `${tag}: ${count}`),
			'',
			'--- Concept profiles (top 5) ---',
			...summary.conceptProfiles.slice(0, 5).map((p) =>
				`${p.tag}: occurrence=${p.occurrenceCount}, resolved=${p.resolvedCount}, ` +
				`unresolved=${p.unresolvedCount}, avgFixAttempts=${p.avgFixAttempts.toFixed(2)}`
			),
			'',
			'--- Hints ---',
			`total hints: ${summary.hintStats.totalHints}`,
			`avg hints before success: ${summary.hintStats.avgHintsBeforeSuccess.toFixed(2)}`,
			`help seeking ratio: ${summary.metrics.helpSeekingRatio.toFixed(2)}`,
			`independent fix ratio: ${summary.metrics.independentFixRatio.toFixed(2)}`,
			'',
			'--- Suggested steps ---',
			...summary.suggestedSteps.map((s) => `- ${s}`),
		];

		if (resolvedWithEdit.length > 0) {
			lines.push('');
			lines.push('--- Recent fixes (diff) ---');
			for (const lifecycle of resolvedWithEdit) {
				const edit = allEvents.find(
					(e) => e.id === lifecycle.resolvingEditId && e.type === 'code_modified'
				);
				if (!edit || edit.type !== 'code_modified') {
					continue;
				}
				const tags = lifecycle.signature.knowledgeTags.join(', ') || 'unknown';
				lines.push('');
				lines.push(`Resolved error (${tags}):`);
				lines.push('```diff');
				lines.push(formatFixAsDiff(edit.before, edit.after));
				lines.push('```');
			}
		}

		return lines.join('\n');
	}

	private async _insertDebugJourney(userText: string, filePath?: string): Promise<void> {
		const content = await this._buildDebugJourneyContent();
		const message: ChatMessage = {
			id: this._generateId(),
			role: 'system',
			content,
			intent: undefined,
			isDebugJourney: true,
			timestamp: Date.now(),
		};

		await this._emitDebugMessage(message, filePath);
	}

	private async _buildDebugLogContent(): Promise<string> {
		if (!this._debugStore) {
			return 'Debug store is not initialized.';
		}

		const index = await this._debugStore.getIndex();
		const recent = await this._debugStore.getEvents();
		return formatDebugLog(recent, index, this._debugStore.workspaceId);
	}

	private async _buildRawDebugLogContent(): Promise<string> {
		if (!this._debugStore) {
			return 'Debug store is not initialized.';
		}

		const index = await this._debugStore.getIndex();
		const events = await this._debugStore.getEvents();
		return formatRawDebugLog(events, index, this._debugStore.workspaceId);
	}

	/**
	 * 调试信息统一出口:带 filePath 时写入文件并打开(供 //show-xxx <路径> 使用),
	 * 否则作为 system 调试消息插入聊天。
	 */
	private async _emitDebugMessage(message: ChatMessage, filePath?: string): Promise<void> {
		if (filePath) {
			const uri = this._resolveDebugOutputUri(filePath);
			try {
				await mkdir(path.dirname(uri.fsPath), { recursive: true });
				await vscode.workspace.fs.writeFile(uri, Buffer.from(message.content, 'utf8'));
				const document = await vscode.workspace.openTextDocument(uri);
				// 走 ADD2 统一分组决策:面板 active 时不经面板组,避免 #18 闪屏。
				await showTextDocumentRespectingPanels(document, { preview: true });
			} catch (error) {
				void vscode.window.showErrorMessage(
					`ClassMate: 调试信息写入失败 ${uri.fsPath}: ` +
					`${error instanceof Error ? error.message : String(error)}`
				);
			}
			return;
		}
		this._state = {
			...this._state,
			messages: [...this._state.messages, message],
		};
		this._broadcast({ type: 'stateSync', state: this._state });
	}

	/** 相对路径解析到固定调试目录(智理杯/log);绝对路径原样;log 目录已从工作区上下文排除。 */
	private _resolveDebugOutputUri(filePath: string): vscode.Uri {
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		const activeFileDir = vscode.window.activeTextEditor
			? path.dirname(vscode.window.activeTextEditor.document.uri.fsPath)
			: undefined;
		return vscode.Uri.file(
			resolveDebugOutputPath(filePath, {
				debugOutputDir: this._debugOutputDir,
				workspaceRoot,
				activeFileDir,
				cwd: process.cwd(),
			})
		);
	}

	/** 注入调试输出目录(扩展激活时设为 `<扩展项目根>/log`,开发态即 智理杯/log)。 */
	public setDebugOutputDir(fsPath: string): void {
		this._debugOutputDir = fsPath;
	}

	public setDiagnosticRecorder(
		recorder: ConversationDiagnosticRecorder,
		metadata: { extensionVersion: string; workspaceFolders: string[] }
	): void {
		this._diagnosticRecorder = recorder;
		this._diagnosticMetadata = metadata;
	}

	private _recordDiagnostic(
		type: Parameters<ConversationDiagnosticRecorder['record']>[0]['type'],
		context: { conversationId?: string; requestId?: string },
		data: unknown
	): void {
		try {
			this._diagnosticRecorder?.record({
				type,
				conversationId: context.conversationId,
				requestId: context.requestId,
				data,
			});
		} catch (error) {
			console.warn('ClassMate conversation diagnostics record failed:', error);
		}
	}

	public async exportDiagnostics(
		filePath?: string,
		options: { reveal?: boolean } = {}
	): Promise<ConversationDiagnosticBundle> {
		if (!this._diagnosticRecorder || !this._diagnosticMetadata) {
			throw new Error('ClassMate conversation diagnostics are not initialized.');
		}
		this._saveActiveConversation();
		const defaultName = `classmate-conversation-diagnostics-${new Date()
			.toISOString()
			.replace(/[:.]/g, '-')}.json`;
		const uri = this._resolveDebugOutputUri(filePath ?? defaultName);
		const bundle = await this._diagnosticRecorder.exportTo(uri.fsPath, {
			extensionVersion: this._diagnosticMetadata.extensionVersion,
			provider: this._llmConfig?.provider,
			model: this._llmConfig?.model,
			workspaceFolders: this._diagnosticMetadata.workspaceFolders,
			activeConversationId: this._state.activeConversationId,
			conversations: [...this._conversationRecords.values()],
		});
		if (options.reveal !== false) {
			const document = await vscode.workspace.openTextDocument(uri);
			await showTextDocumentRespectingPanels(document, { preview: true });
			void vscode.window.showInformationMessage(
				`ClassMate: 已导出 ${bundle.conversations.length} 段对话和 ${bundle.events.length} 条诊断事件。`
			);
		}
		return bundle;
	}

	private async _insertDebugLog(userText: string, filePath?: string): Promise<void> {
		const content = await this._buildDebugLogContent();
		const message: ChatMessage = {
			id: this._generateId(),
			role: 'system',
			content,
			intent: undefined,
			isDebugLog: true,
			timestamp: Date.now(),
		};

		await this._emitDebugMessage(message, filePath);
	}

	private async _insertRawDebugLog(userText: string, filePath?: string): Promise<void> {
		const content = await this._buildRawDebugLogContent();
		const message: ChatMessage = {
			id: this._generateId(),
			role: 'system',
			content,
			intent: undefined,
			isDebugRawLog: true,
			timestamp: Date.now(),
		};

		await this._emitDebugMessage(message, filePath);
	}

	/** //show-ref:输出最近一次 assistant 回答的原始内容 + 消歧清单 + 提取结果,便于排查链接问题。 */
	private async _insertReferenceDebug(userText: string, filePath?: string): Promise<void> {
		const assistants = this._state.messages.filter((m) => m.role === 'assistant');
		const message = [...assistants].reverse().find((m) => m.referenceDebug)
			?? [...assistants].reverse()[0];
		const sections: string[] = [];
		if (!message) {
			sections.push('当前对话还没有 assistant 回答。');
		} else {
			sections.push(
				'【原始回答(未转超链接)】',
				message.content || '(空)',
				'',
				message.referenceDebug
					? [
						'【消歧用工作区极简内容清单(文件 → 符号)】',
						JSON.stringify(message.referenceDebug.files, null, 2),
					].join('\n')
					: '【消歧用工作区极简内容清单】\n(该消息没有提取调试信息:可能回答不含代码提及、或提取未运行)',
				'',
				'【提取结果 references】',
				JSON.stringify(message.references ?? [], null, 2)
			);
		}
		const content = ['=== DEBUG: 回答引用调试 ===', '', ...sections].join('\n');
		const debugMessage: ChatMessage = {
			id: this._generateId(),
			role: 'system',
			content,
			intent: undefined,
			isDebugLog: true,
			timestamp: Date.now(),
		};
		await this._emitDebugMessage(debugMessage, filePath);
	}

	/** //show-usage:输出最近一次图流程里各节点与总计的 token 用量,便于确认缓存字段是否被 provider 上报。 */
	private async _insertUsageDebug(userText: string, filePath?: string): Promise<void> {
		const sections: string[] = [];
		const debug = this._lastUsageDebug;
		if (!debug || !debug.total) {
			sections.push('当前对话还没有一次完整的模型调用,暂无 usage 可展示。');
		} else {
			const describe = (usage: LLMTokenUsage | undefined): string => {
				if (!usage) {
					return '(无)';
				}
				const parts = [
					`input=${usage.inputTokens}`,
					`output=${usage.outputTokens}`,
					`total=${usage.totalTokens ?? usage.inputTokens + usage.outputTokens}`,
				];
				parts.push(
					usage.cacheHitTokens !== undefined
						? `cacheHit=${usage.cacheHitTokens}`
						: 'cacheHit=未报告(undefined)'
				);
				parts.push(
					usage.cacheMissTokens !== undefined
						? `cacheMiss=${usage.cacheMissTokens}`
						: 'cacheMiss=未报告(undefined)'
				);
				return parts.join(' · ');
			};
			sections.push(
				'【按节点】',
				...Object.entries(debug.byNode).map(
					([label, usage]) => `${label}: ${describe(usage)}`
				),
				'',
				'【总计】',
				describe(debug.total)
			);
		}
		const content = ['=== DEBUG: 模型用量 (usage) ===', '', ...sections].join('\n');
		const message: ChatMessage = {
			id: this._generateId(),
			role: 'system',
			content,
			intent: undefined,
			isDebugLog: true,
			timestamp: Date.now(),
		};
		await this._emitDebugMessage(message, filePath);
	}

	/** //show-prompts:输出最近一次图流程里各节点真实发送给模型的完整提示词(与 //show-prompt 的旧路径 system prompt 不同)。 */
	private async _insertPromptsDebug(userText: string, filePath?: string): Promise<void> {
		const entries = Object.entries(this._lastPromptsDebug);
		const sections: string[] = [];
		if (entries.length === 0) {
			sections.push('当前对话还没有一次完整的图流程调用,暂无节点提示词可展示。');
		} else {
			for (const [label, messages] of entries) {
				sections.push(`【${label}】`);
				sections.push(
					...messages.map((m) => `--- ${m.role} ---\n${m.content}`)
				);
				sections.push('');
			}
		}
		const content = [
			'=== DEBUG: 各节点真实提示词 (graph prompts) ===',
			'',
			...sections,
		].join('\n');
		const message: ChatMessage = {
			id: this._generateId(),
			role: 'system',
			content,
			intent: undefined,
			isDebugLog: true,
			timestamp: Date.now(),
		};
		await this._emitDebugMessage(message, filePath);
	}

	private async _insertSystemPromptDebug(
		systemMessages: LLMRequest['messages'],
		userText: string,
		filePath?: string
	): Promise<void> {
		const debugContent = [
			'=== DEBUG: system prompt sent to LLM ===',
			'',
			...systemMessages.map((m) => `--- ${m.role} ---\n${m.content}`),
			'',
			'--- user ---',
			userText,
		].join('\n');

		const message: ChatMessage = {
			id: this._generateId(),
			role: 'system',
			content: debugContent,
			intent: undefined,
			isSystemPromptDebug: true,
			timestamp: Date.now(),
		};

		await this._emitDebugMessage(message, filePath);
	}

	public static getInstance(): ChatSession {
		if (!ChatSession._instance) {
			ChatSession._instance = new ChatSession();
		}
		return ChatSession._instance;
	}

	public setOnIntent(callback: (intent: MessageIntent) => void): void {
		this._onIntent = callback;
	}

	public setOnRequestLLMConfig(callback: () => Promise<LLMConfig>): void {
		this._onRequestLLMConfig = callback;
	}

	public setOnGetApiKey(callback: () => Promise<string | undefined>): void {
		this._onGetApiKey = callback;
	}

	public setOnSaveLLMConfig(callback: (provider: string, model: string, apiKey?: string, apiUrl?: string) => void): void {
		this._onSaveLLMConfig = callback;
	}

	public setOnSaveFallbackLLMConfig(callback: (input: {
		provider: LLMProvider;
		model: string;
		apiKey?: string;
		apiUrl?: string;
	} | null) => void): void {
		this._onSaveFallbackLLMConfig = callback;
	}

	public setPromptBuilder(builder: SystemPromptBuilder): void {
		this._promptBuilder = builder;
	}

	public setGraphServices(services: Omit<ClassMateGraphServices, 'model' | 'signal'>): void {
		this._graphServices = services;
	}

	public setPerformanceTraceSink(callback: (event: string, data: unknown) => void): void {
		this._onPerformanceTrace = callback;
	}

	public setDebugStore(store: DebugJourneyStore, sessionId: string, workspaceId: string): void {
		this._debugStore = store;
		this._sessionId = sessionId;
		this._workspaceId = workspaceId;
	}

	public setLLMConfig(config: LLMConfig): void {
		this._llmConfig = config;
		this._broadcast({ type: 'llmConfig', config });
	}

	/** 备用 provider 配置(7.8 恢复通道);undefined 表示未配置。 */
	public setFallbackLLMConfig(
		config: LLMConfig | undefined,
		onGetApiKey?: () => Promise<string | undefined>
	): void {
		this._fallbackLLMConfig = config;
		this._onGetFallbackApiKey = onGetApiKey;
	}

	public static resetInstance(): void {
		ChatSession._instance = undefined;
	}

	public attach(presenter: WebviewPresenter): void {
		this._presenters.add(presenter);
		// attach 时前端刚挂载,需要把当前对话的 inputDraft 投影过去。
		presenter.postMessage({ type: 'stateSync', state: this._state });
		presenter.postMessage({ type: 'containerInfo', container: this._getPresenterContainer(presenter) });
	}

	private _getPresenterContainer(presenter: WebviewPresenter): 'view' | 'panel' {
		if (presenter.constructor.name === 'ChatPanel') {
			return 'panel';
		}
		return 'view';
	}

	public detach(presenter: WebviewPresenter): void {
		this._presenters.delete(presenter);
	}

	public getState(): ChatState {
		return this._state;
	}

	public setInputDraft(text: string): void {
		// 接收前端 inputDraftChanged 时:只更新当前 _state.inputDraft 和落盘,不广播。
		// 原因:每个按键都触发一次 inputDraftChanged,如果后端 echo stateSync,
		// 前端 React 会陷入"setInput → render → 下一个 keydown"的串行瓶颈,
		// 体感上输入框字符跟不上打字速度。前端会用 composerDirtyRef 阻挡后端 echo,
		// 但 IPC 来回本身就有 1–5ms 抖动,合起来就是肉眼可见的落后。
		// 真正需要把 inputDraft 推回前端的时机是:
		//   - newConversation / switchConversation / clear (前端的 dirty 已被清掉,
		//     此时后端的 inputDraft 是目标对话的权威草稿,前端必须采用)
		//   - 持久化重启后首次 attach (前端 init state 用)
		// 这些路径显式走 _broadcast(stateSync, {includeDraft: true}),不依赖本方法。
		this._state = { ...this._state, inputDraft: text };
		// 同步把当前对话记录的 inputDraft 写进 _conversationRecords,但跳过
		// 重新计算 conversations 列表(那是为了渲染历史侧栏,频繁打字时不需要)。
		const activeId = this._state.activeConversationId;
		const existing = this._conversationRecords.get(activeId);
		if (existing) {
			this._conversationRecords.set(activeId, { ...existing, inputDraft: text });
		}
		// 轻量持久化:让 _onPersist 知道当前草稿变了,但不在 _state.conversations 上
		// 反复排序重建。
		void this._onPersist?.({
			activeConversationId: activeId,
			conversations: [...this._conversationRecords.values()],
		});
	}

	public addUserMessage(text: string, options?: { intent?: MessageIntent; isCommandGenerated?: boolean; images?: ChatImage[]; attachments?: ChatAttachment[] }): ChatMessage {
		const message: ChatMessage = {
			id: this._generateId(),
			role: 'user',
			content: text,
			intent: options?.intent,
			isCommandGenerated: options?.isCommandGenerated,
			references: this._referenceProvider?.(),
			images: options?.images,
			attachments: options?.attachments,
			timestamp: Date.now(),
		};
		this._state = {
			...this._state,
			messages: [...this._state.messages, message],
			inputDraft: '',
		};
		this._broadcast({ type: 'stateSync', state: this._state }, { includeDraft: true });
		return message;
	}

	public startAssistantMessage(intent?: ChatMessage['intent']): ChatMessage {
		const message: ChatMessage = {
			id: this._generateId(),
			role: 'assistant',
			content: '',
			intent,
			timestamp: Date.now(),
		};
		this._state = {
			...this._state,
			messages: [...this._state.messages, message],
			isStreaming: true,
			currentStreamMessageId: message.id,
			processingStage: '正在准备请求…',
		};
		this._broadcast({ type: 'streamStart', message });
		return message;
	}

	public appendToken(messageId: string, token: string): void {
		this._state = {
			...this._state,
			messages: this._state.messages.map((m) =>
				m.id === messageId ? { ...m, content: m.content + token } : m
			),
		};
		this._broadcast({ type: 'appendToken', messageId, token });
	}

	private _setProcessingStage(stage: string | null): void {
		if (this._state.processingStage === stage) {
			return;
		}
		this._state = { ...this._state, processingStage: stage };
		this._broadcast({ type: 'stateSync', state: this._state });
	}

	public endStream(): void {
		const endedId = this._state.currentStreamMessageId;
		this._state = {
			...this._state,
			isStreaming: false,
			currentStreamMessageId: null,
			processingStage: null,
		};
		if (endedId) {
			this._broadcast({
				type: 'streamEnd',
				messageId: endedId,
			});
		}
		this._broadcast({ type: 'stateSync', state: this._state });
	}

	public configurePersistence(
		data: PersistedChatData | undefined,
		onPersist: (value: PersistedChatData) => Thenable<void>
	): void {
		this._onPersist = onPersist;
		if (data?.conversations.length) {
			for (const conversation of data.conversations) {
				this._conversationRecords.set(conversation.id, conversation);
			}
			const active = this._conversationRecords.get(data.activeConversationId)
				?? data.conversations[0];
			this._state = {
				messages: active.messages,
				inputDraft: active.inputDraft,
				isStreaming: false,
				currentStreamMessageId: null,
				processingStage: null,
				activeConversationId: active.id,
				conversations: [],
			};
		}
		this._syncConversationState();
	}

	public setReferenceHandlers(
		provider: () => ChatReference[],
		onOpen: (reference: ChatReference) => void
	): void {
		this._referenceProvider = provider;
		this._onOpenReference = onOpen;
	}

	public newConversation(): void {
		if (this._state.isStreaming) {
			return;
		}
		this._saveActiveConversation();
		this._state = {
			messages: [],
			inputDraft: '',
			isStreaming: false,
			currentStreamMessageId: null,
			processingStage: null,
			activeConversationId: createConversationId(),
			conversations: this._state.conversations,
		};
		this._broadcast({ type: 'stateSync', state: this._state }, { includeDraft: true });
	}

	public switchConversation(conversationId: string): void {
		if (this._state.isStreaming || conversationId === this._state.activeConversationId) {
			return;
		}
		const target = this._conversationRecords.get(conversationId);
		if (!target) {
			return;
		}
		this._saveActiveConversation();
		this._state = {
			messages: target.messages,
			inputDraft: target.inputDraft,
			isStreaming: false,
			currentStreamMessageId: null,
			processingStage: null,
			activeConversationId: target.id,
			conversations: this._state.conversations,
		};
		this._broadcast({ type: 'stateSync', state: this._state }, { includeDraft: true });
	}

	/**
	 * 删除一个会话记录。删除当前会话时自动切到 updatedAt 最新的剩余会话;
	 * 一个都不剩时新建一个空会话,保证聊天界面不黑屏。
	 * 只影响记录与摘要,不动原始隐式日志。
	 */
	public deleteConversation(conversationId: string): void {
		if (this._state.isStreaming) {
			return;
		}
		if (!this._conversationRecords.has(conversationId)) {
			return;
		}
		this._conversationRecords.delete(conversationId);

		if (conversationId !== this._state.activeConversationId) {
			this._syncConversationState();
			this._broadcast({ type: 'stateSync', state: this._state });
			return;
		}

		const remaining = [...this._conversationRecords.values()].sort(
			(a, b) => b.updatedAt - a.updatedAt
		);
		if (remaining.length > 0) {
			const next = remaining[0];
			this._state = {
				messages: next.messages,
				inputDraft: next.inputDraft,
				isStreaming: false,
				currentStreamMessageId: null,
				processingStage: null,
				activeConversationId: next.id,
				conversations: this._state.conversations,
			};
		} else {
			this._state = {
				messages: [],
				inputDraft: '',
				isStreaming: false,
				currentStreamMessageId: null,
				processingStage: null,
				activeConversationId: createConversationId(),
				conversations: this._state.conversations,
			};
		}
		this._syncConversationState();
		this._broadcast({ type: 'stateSync', state: this._state }, { includeDraft: true });
	}

	private _setMessageUsage(messageId: string, usage: import('../llm/types').LLMTokenUsage): void {
		this._state = {
			...this._state,
			messages: this._state.messages.map((message) =>
				message.id === messageId ? { ...message, usage } : message
			),
		};
		this._broadcast({ type: 'stateSync', state: this._state });
	}

	/** 记录该轮回答依据的冻结快照 hash(7.8 历史精确绑定)。 */
	private _setMessageBasisFileHashes(
		messageId: string,
		fileHashes: Record<string, string>
	): void {
		if (Object.keys(fileHashes).length === 0) {
			return;
		}
		this._state = {
			...this._state,
			messages: this._state.messages.map((message) =>
				message.id === messageId
					? { ...message, basisFileHashes: fileHashes }
					: message
			),
		};
	}

	private _setMessageContextSummary(
		messageId: string,
		workspaceFiles: string[],
		codeFiles?: string[]
	): void {		const uniqueFiles = [...new Set(workspaceFiles)].sort((left, right) =>
			left.localeCompare(right, 'zh-CN')
		);
		const uniqueCodeFiles = codeFiles
			? [...new Set(codeFiles)].sort((left, right) => left.localeCompare(right, 'zh-CN'))
			: undefined;
		this._state = {
			...this._state,
			messages: this._state.messages.map((message) =>
				message.id === messageId
					? {
						...message,
						contextSummary: uniqueCodeFiles
							? { workspaceFiles: uniqueFiles, codeFiles: uniqueCodeFiles }
							: { workspaceFiles: uniqueFiles },
					}
					: message
			),
		};
		this._broadcast({ type: 'stateSync', state: this._state });
	}

	private _setReferenceExtractionPending(messageId: string): void {
		this._state = { ...this._state, referenceExtractionPendingFor: messageId };
		this._broadcast({ type: 'stateSync', state: this._state });
	}

	private _clearReferenceExtractionPending(messageId: string): void {
		if (this._state.referenceExtractionPendingFor !== messageId) {
			return;
		}
		this._state = { ...this._state, referenceExtractionPendingFor: null };
		this._broadcast({ type: 'stateSync', state: this._state });
	}

	private _setMessageReferenceDebug(
		messageId: string,
		files: ReferenceExtractionFile[]
	): void {
		this._state = {
			...this._state,
			messages: this._state.messages.map((item) =>
				item.id === messageId ? { ...item, referenceDebug: { files } } : item
			),
		};
		this._broadcast({ type: 'stateSync', state: this._state });
	}

	/** 程序侧块来源证词挂到消息(不渲染,持久化随会话)。 */
	private _setMessageBlockSources(
		messageId: string,
		blockSources: NonNullable<ChatMessage['blockSources']>
	): void {
		this._state = {
			...this._state,
			messages: this._state.messages.map((item) =>
				item.id === messageId ? { ...item, blockSources } : item
			),
		};
		this._broadcast({ type: 'stateSync', state: this._state });
	}

	private _setMessageReferences(messageId: string, references: ChatReference[]): void {		if (references.length === 0) {
			this._clearReferenceExtractionPending(messageId);
			return;
		}
		const message = this._state.messages.find((item) => item.id === messageId);
		if (!message || message.role !== 'assistant') {
			this._clearReferenceExtractionPending(messageId);
			return;
		}
		this._state = {
			...this._state,
			referenceExtractionPendingFor: null,
			messages: this._state.messages.map((item) =>
				item.id === messageId ? { ...item, references } : item
			),
		};
		this._broadcast({ type: 'stateSync', state: this._state });
	}

	/**
	 * 流结束后的引用提取:先让 endStream 收尾,再异步跑提取并挂载,
	 * 不拖慢流式时序;期间显示"正在定位回答中的代码位置…"。
	 * 兜底策略(2026-08-19 用户拍板):extract_references 一律调用,但只处理
	 * 模型没有提到的部分——提取结果与模型 Answer 引用(契约标记生成)重合时
	 * 一律以模型为准丢弃提取版;合并防止同一符号二次链接。
	 */
	private async _extractAndAttachReferences(
		messageId: string,
		answer: string,
		loadedItems: LoadedWorkspaceItem[],
		model: GraphModelClient,
		signal?: AbortSignal,
		diagnosticContext: { conversationId: string; requestId: string } = {
			conversationId: this._state.activeConversationId,
			requestId: 'unknown',
		},
		contractReferences?: ChatReference[]
	): Promise<void> {
		if (!answer.trim() || loadedItems.length === 0) {
			this._recordDiagnostic('reference_extraction_completed', diagnosticContext, {
				messageId,
				answer,
				loadedItems,
				files: [],
				references: contractReferences ?? [],
				skipped: !answer.trim() ? 'empty_answer' : 'no_loaded_workspace_files',
			});
			if (contractReferences?.length) {
				this._setMessageReferences(messageId, contractReferences);
			}
			return;
		}
		// 防御:提取只针对自然行文正文;引用契约的标记/链接尾巴先剥离。
		const cleanAnswer = stripContractNotation(answer);
		// 预过滤:模型已标记的符号不再交给提取小调用(只处理没提到的部分)。
		const contractSymbols = new Set(
			(contractReferences ?? [])
				.map((item) => item.symbol)
				.filter((symbol): symbol is string => Boolean(symbol))
		);
		const files = buildReferenceExtractionInput(loadedItems, cleanAnswer)
			.map((file) => ({
				...file,
				symbols: file.symbols.filter((symbol) => !contractSymbols.has(symbol.name)),
			}))
			.filter((file) => file.symbols.length > 0);
		if (contractReferences?.length && files.length === 0) {
			// 模型已提及全部可提取符号:无需第二次模型调用。
			this._recordDiagnostic('reference_extraction_completed', diagnosticContext, {
				messageId,
				answer,
				loadedItems,
				files: [],
				references: contractReferences,
				skipped: 'contract_covers_all_symbols',
			});
			return;
		}
		this._setReferenceExtractionPending(messageId);
		this._setMessageReferenceDebug(messageId, files);
		try {
			const extracted = await extractAnswerReferences(cleanAnswer, loadedItems, {
				model,
				workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri,
				signal,
			});
			const references = contractReferences
				? mergeContractAndExtractedReferences(contractReferences, extracted)
				: extracted;
			this._setMessageReferences(messageId, references);
			this._recordDiagnostic('reference_extraction_completed', diagnosticContext, {
				messageId,
				answer,
				loadedItems,
				files,
				references,
			});
		} catch (error) {
			console.warn('ClassMate answer reference extraction failed:', error);
			this._clearReferenceExtractionPending(messageId);
			this._recordDiagnostic('reference_extraction_failed', diagnosticContext, {
				messageId,
				answer,
				loadedItems,
				files,
				error,
			});
		}
	}

	public cancelCurrentResponse(): void {
		if (!this._state.isStreaming) {
			return;
		}
		this._setProcessingStage('正在停止回答…');
		this._graphAbortController?.abort();
	}

	public clear(): void {
		this._state = {
			messages: [],
			inputDraft: '',
			isStreaming: false,
			currentStreamMessageId: null,
			processingStage: null,
			activeConversationId: this._state.activeConversationId,
			conversations: this._state.conversations,
		};
		this._broadcast({ type: 'stateSync', state: this._state }, { includeDraft: true });
	}

	public handleWebviewMessage(message: WebviewToExtensionMessage): void {
		switch (message.type) {
			case 'inputDraftChanged':
				this.setInputDraft(message.text);
				break;
			case 'sendMessage':
				void this._handleSendMessage(message);
				break;
			case 'requestContainerToggle':
				// The extension host decides actual container switching.
				void vscode.commands.executeCommand('classmate.toggleChatContainer');
				break;
			case 'requestLLMConfig':
				void this._onRequestLLMConfig?.().then((config) =>
					this._broadcast({ type: 'llmConfig', config })
				);
				break;
			case 'saveLLMConfig':
				this._onSaveLLMConfig?.(message.provider, message.model, message.apiKey, message.apiUrl);
				break;
			case 'saveFallbackLLMConfig':
				// input 为 null 表示清除备用配置。
				this._onSaveFallbackLLMConfig?.(message.input ? {
					provider: message.input.provider,
					model: message.input.model,
					apiKey: message.input.apiKey,
					apiUrl: message.input.apiUrl,
				} : null);
				break;
			case 'newConversation':
				this.newConversation();
				break;
			case 'switchConversation':
				this.switchConversation(message.conversationId);
				break;
			case 'deleteConversation':
				this.deleteConversation(message.conversationId);
				break;
			case 'openReference':
				if (message.inferred) {
					this._recordDiagnostic('reference_link_opened', {
						conversationId: this._state.activeConversationId,
						requestId: 'unknown',
					}, { inferred: true, reference: message.reference });
				}
				this._onOpenReference?.(message.reference);
				break;
			case 'applyProposedEdit':
				void this._applyProposedEdit(message.messageId);
				break;
			case 'cancelResponse':
				this.cancelCurrentResponse();
				break;
			default:
				console.log('Unhandled webview message:', message);
		}
	}

	private _recordHintRequested(userText: string, intent?: MessageIntent, fileUri?: string, selection?: string): void {
		if (!intent || !HINT_INTENTS.includes(intent)) {
			return;
		}
		if (!this._debugStore || !this._sessionId || !this._workspaceId) {
			return;
		}

		const event: HintRequestedEvent = {
			id: this._generateId(),
			type: 'hint_requested',
			timestamp: Date.now(),
			sessionId: this._sessionId,
			workspaceId: this._workspaceId,
			fileUri,
			intent,
			userPrompt: userText,
			selection,
		};

		void this._debugStore.append(event);
	}

	public startIntentResponse(intent: MessageIntent, userPrompt?: string): void {
		const prompt = userPrompt ?? `/${intent}`;
		this.addUserMessage(prompt, { intent, isCommandGenerated: true });
		this._onIntent?.(intent);
		// Defer the LLM call by one tick so the webview has time to render the
		// user bubble before the assistant message starts streaming.
		setTimeout(() => void this._callLLM(prompt, intent), 50);
	}

	private async _callLLM(userText: string, frontendIntent?: MessageIntent): Promise<void> {
		const debugCommand = parseDebugCommand(userText);
		if (debugCommand?.command === 'show-ref') {
			await this._insertReferenceDebug(userText, debugCommand.filePath);
			return;
		}
		if (debugCommand?.command === 'show-log') {
			await this._insertDebugLog(userText, debugCommand.filePath);
			return;
		}
		if (debugCommand?.command === 'show-raw-log') {
			await this._insertRawDebugLog(userText, debugCommand.filePath);
			return;
		}
		if (debugCommand?.command === 'knowledge-cards') {
			await this._insertKnowledgeCards(userText, debugCommand.filePath);
			return;
		}
		if (debugCommand?.command === 'show-journey') {
			await this._insertDebugJourney(userText, debugCommand.filePath);
			return;
		}
		if (debugCommand?.command === 'show-usage') {
			await this._insertUsageDebug(userText, debugCommand.filePath);
			return;
		}
		if (debugCommand?.command === 'show-prompts') {
			await this._insertPromptsDebug(userText, debugCommand.filePath);
			return;
		}
		if (debugCommand?.command === 'export-diagnostics') {
			try {
				await this.exportDiagnostics(debugCommand.filePath);
			} catch (error) {
				void vscode.window.showErrorMessage(
					`ClassMate: 对话诊断导出失败：${error instanceof Error ? error.message : String(error)}`
				);
			}
			return;
		}

		let messages: LLMRequest['messages'] = [];
		try {
			const showPrompt = debugCommand?.command === 'show-prompt';
			if (this._promptBuilder && (showPrompt || !this._graphServices)) {
				const systemMessages = await this._promptBuilder.build(frontendIntent, userText);
				messages = [...systemMessages, ...this._getConversationHistory()];
				if (showPrompt) {
					await this._insertSystemPromptDebug(systemMessages, userText, debugCommand?.filePath);
					return;
				}
			} else {
				messages = this._getConversationHistory();
			}
		} catch (error) {
			console.error('Failed to build system prompt:', error);
			messages = this._getConversationHistory();
		}

		const editTarget = frontendIntent === 'code_edit' ? await this._captureEditTarget() : undefined;
		const assistantMessage = this.startAssistantMessage(frontendIntent);

		const cfg = this._llmConfig;
		if (!cfg) {
			this.appendToken(assistantMessage.id, 'LLM config is not available.');
			this.endStream();
			return;
		}

		const apiKey = await this._onGetApiKey?.();
		if (!apiKey && !cfg.apiKeySet) {
			this.appendToken(assistantMessage.id, 'API key is not configured.');
			this.endStream();
			return;
		}

		const adapter = this._createAdapter(cfg, apiKey);
		if (!adapter) {
			this.appendToken(assistantMessage.id, 'Failed to create LLM adapter.');
			this.endStream();
			return;
		}

		this._currentAdapter = adapter;

		if (this._graphServices) {
			this._graphAbortController?.abort();
			const controller = new AbortController();
			this._graphAbortController = controller;
			const graphRequestId = this._generateId();
			const graphStartedAt = Date.now();
			const graphConversationId = this._state.activeConversationId;
			const previousWorkspaceContext = this._conversationWorkspaceContexts.get(
				graphConversationId
			);
			const history = this._state.messages
				.filter((message): message is typeof message & { role: 'user' | 'assistant' } =>
					(message.role === 'user' || message.role === 'assistant')
					&& message.content.trim().length > 0
				)
				.map((message) => ({
					role: message.role,
					content: message.content,
					images: message.images,
					attachments: message.attachments,
				// 引用契约:该轮回答实际链接的文件 + 程序侧块来源实证文件,
				// 供历史裁剪精确绑定(模型不标记时块溯源仍生效)。
					referenceFiles: [
						...(message.references
							?.map((reference) => path.basename(reference.uri))
							.filter((file): file is string => Boolean(file)) ?? []),
						...(message.blockSources
							?.map((block) => block.file)
							.filter((file): file is string => Boolean(file)) ?? []),
					].filter((file, index, all) => all.indexOf(file) === index),
					// 7.8:该轮依据的冻结 hash,逐轮精确绑定历史清洗。
					basisFileHashes: message.basisFileHashes,
				}));
			const activeEditor = vscode.window.activeTextEditor;
			this._recordDiagnostic('turn_started', {
				conversationId: graphConversationId,
				requestId: graphRequestId,
			}, {
				assistantMessageId: assistantMessage.id,
				userText,
				frontendIntent,
				requestSource: frontendIntent && frontendIntent !== 'chat'
					? 'button'
					: 'conversation',
				conversationHistory: history,
				previousWorkspaceContext,
				llmConfig: cfg,
				workspaceFolders: vscode.workspace.workspaceFolders?.map((folder) => ({
					name: folder.name,
					uri: folder.uri.toString(),
				})) ?? [],
				activeEditor: activeEditor ? {
					uri: activeEditor.document.uri.toString(),
					languageId: activeEditor.document.languageId,
					version: activeEditor.document.version,
					isDirty: activeEditor.document.isDirty,
					content: activeEditor.document.getText(),
					selection: {
						startLine: activeEditor.selection.start.line + 1,
						startCharacter: activeEditor.selection.start.character + 1,
						endLine: activeEditor.selection.end.line + 1,
						endCharacter: activeEditor.selection.end.character + 1,
					},
				} : undefined,
			});
			this._onPerformanceTrace?.('request_started', {
				requestId: graphRequestId,
				startedAt: graphStartedAt,
				userText,
			});
			// 一个图流程会多次调用模型，这里累计每次调用的用量。
			let graphUsage: LLMTokenUsage | undefined;
			let firstAnswerTokenAt: number | undefined;
			let hasAnswerToken = false;
			const graphUsageByNode: Record<string, LLMTokenUsage> = {};
			const model = new AdapterGraphModelClient(adapter, cfg.model, (usage, label) => {
				graphUsage = addTokenUsage(graphUsage, usage);
				const usageLabel = label ?? 'unknown';
				graphUsageByNode[usageLabel] = addTokenUsage(
					graphUsageByNode[usageLabel] ?? { inputTokens: 0, outputTokens: 0 },
					usage
				);
				this._setMessageUsage(assistantMessage.id, graphUsage);
				this._onPerformanceTrace?.('model_usage', {
					requestId: graphRequestId,
					node: usageLabel,
					usage,
				});
			}, (messages, label) => {
				this._lastPromptsDebug[label ?? 'unknown'] = messages;
			}, (trace: GraphModelTrace) => {
				const type = trace.phase === 'request'
					? 'model_request'
					: trace.phase === 'response'
						? 'model_response'
						: 'model_error';
				this._recordDiagnostic(type, {
					conversationId: graphConversationId,
					requestId: graphRequestId,
				}, trace);
			});
			// 7.8 恢复通道:显式配置了备用 provider 且 key 可用时,主 client
			// 失败自动切备用重发一次(每轮最多一次);成功路径不受影响。
			let graphModel: GraphModelClient = model;
			if (this._fallbackLLMConfig) {
				const fallbackApiKey = await this._onGetFallbackApiKey?.();
				const fallbackAdapter = fallbackApiKey || this._fallbackLLMConfig.apiKeySet
					? this._createAdapter(this._fallbackLLMConfig, fallbackApiKey)
					: undefined;
				if (fallbackAdapter) {
					graphModel = new FallbackGraphModelClient({
						primary: model,
						fallback: new AdapterGraphModelClient(
							fallbackAdapter,
							this._fallbackLLMConfig.model,
							(usage, label) => {
								graphUsage = addTokenUsage(graphUsage, usage);
								graphUsageByNode[`${label ?? 'unknown'}.fallback`] =
									addTokenUsage(
										graphUsageByNode[`${label ?? 'unknown'}.fallback`]
											?? { inputTokens: 0, outputTokens: 0 },
										usage
									);
							}
						),
						onFallbackUsed: (info) => {
							console.warn(
								`[ClassMate] primary model call failed (${info.label ?? 'unknown'}), retrying on fallback provider ${this._fallbackLLMConfig!.provider}: ${info.error}`
							);
							this._recordDiagnostic('model_fallback_provider_used', {
								conversationId: graphConversationId,
								requestId: graphRequestId,
							}, {
								...info,
								fallbackProvider: this._fallbackLLMConfig!.provider,
								fallbackModel: this._fallbackLLMConfig!.model,
							});
							this._onPerformanceTrace?.('model_fallback_provider_used', {
								requestId: graphRequestId,
								...info,
							});
						},
					});
				}
			}
			const runner = new ClassMateGraphRunner({
				...this._graphServices,
				// 引用契约需要真实根路径生成可点击 URI;每轮求值,
				// 避免记住激活时刻的旧根目录。
				workspaceRootUri: vscode.workspace.workspaceFolders?.[0]?.uri.toString(),
				model: graphModel,
				signal: controller.signal,
				onAnswerToken: (token) => {
					if (!hasAnswerToken && token.length > 0) {
						hasAnswerToken = true;
						this._setProcessingStage(null);
					}
					if (firstAnswerTokenAt === undefined && token.length > 0) {
						firstAnswerTokenAt = Date.now();
						this._onPerformanceTrace?.('answer_first_token', {
							requestId: graphRequestId,
							elapsedMs: firstAnswerTokenAt - graphStartedAt,
						});
					}
					this.appendToken(assistantMessage.id, token);
				},
				onProgress: (_node, message) => {
					if (!hasAnswerToken) {
						this._setProcessingStage(message);
					}
				},
				onDebug: (event, data) => {
					console.debug(`[ClassMate graph] ${event}`, data);
					this._recordDiagnostic('graph_debug', {
						conversationId: graphConversationId,
						requestId: graphRequestId,
					}, { event, data });
					this._onPerformanceTrace?.(event, {
						requestId: graphRequestId,
						data,
					});
				},
				onNodeTrace: (trace) => {
					this._recordDiagnostic(
						trace.status === 'completed'
							? 'graph_node_completed'
							: 'graph_node_failed',
						{
							conversationId: graphConversationId,
							requestId: graphRequestId,
						},
						trace
					);
				},
			});
			try {
				const result = await runner.run({
					requestId: graphRequestId,
					conversationId: graphConversationId,
					userText,
					frontendIntent,
					requestSource: frontendIntent && frontendIntent !== 'chat'
						? 'button'
						: 'conversation',
					buttonId: frontendIntent && frontendIntent !== 'chat'
						? frontendIntent
						: undefined,
					conversationHistory: history,
					previousWorkspaceContext,
				});
				if (result.state.conversationWorkspaceContext) {
					this._conversationWorkspaceContexts.set(
						graphConversationId,
						result.state.conversationWorkspaceContext
					);
				}
				console.info('[ClassMate graph performance]', JSON.stringify({
					requestId: result.state.request.requestId,
					totalDurationMs: result.totalDurationMs,
					nodeTimings: result.nodeTimings,
				}));
				this._onPerformanceTrace?.('request_completed', {
					requestId: graphRequestId,
					totalDurationMs: result.totalDurationMs,
					nodeTimings: result.nodeTimings,
					usage: graphUsage,
					usageByNode: graphUsageByNode,
				});
				// The first answer attempt normally reaches the UI through onAnswerToken.
				// If a provider produced an empty stream, the graph retries through its
				// non-streaming API. Flush that validated fallback answer here so a
				// successful model response can never leave an empty assistant bubble.
				if (!hasAnswerToken && result.answer.trim()) {
					hasAnswerToken = true;
					this._setProcessingStage(null);
					this.appendToken(assistantMessage.id, result.answer);
					this._onPerformanceTrace?.('answer_fallback_flushed', {
						requestId: graphRequestId,
						characters: result.answer.length,
					});
				} else if (
					// 流式中途断流:半截内容已上屏,图内转入了本地事实兜底。
					// 兜底提示不能替换已见内容,只在其后追加,保证学生拿到
					// 确定性事实而不是一条裸错误。
					hasAnswerToken
					&& result.state.answerOutcome === 'recovery_fallback'
				) {
					this.appendToken(
						assistantMessage.id,
						`\n\n${result.answer}`
					);
				}
				this._setMessageContextSummary(
					assistantMessage.id,
					result.state.loadedWorkspaceItems.map((item) => item.path),
					result.state.loadedWorkspaceItems
						.filter((item) => item.kind === 'code')
						.map((item) => item.path)
				);
				this._setMessageBasisFileHashes(
					assistantMessage.id,
					Object.fromEntries(result.state.loadedWorkspaceItems.map((item) => [
						item.path, item.contentHash,
					]))
				);
				if (result.state.answerReferences
					&& result.state.answerReferences.length > 0) {
					// 引用契约:图内已由标记生成精确引用,直接挂到消息,
					// 跳过下面那次独立的引用提取模型调用。
					this._setMessageReferences(
						assistantMessage.id,
						result.state.answerReferences
					);
				}
				if (result.state.answerBlockSources?.length) {
					this._setMessageBlockSources(
						assistantMessage.id,
						result.state.answerBlockSources
					);
				}
				if (editTarget) {
					this._attachProposedEdit(assistantMessage.id, editTarget);
				}
				this._recordDiagnostic('turn_completed', {
					conversationId: graphConversationId,
					requestId: graphRequestId,
				}, {
					answer: result.answer,
					state: result.state,
					totalDurationMs: result.totalDurationMs,
					nodeTimings: result.nodeTimings,
					usage: graphUsage,
					usageByNode: graphUsageByNode,
					assistantMessage: this._state.messages.find(
						(message) => message.id === assistantMessage.id
					),
				});
				// 流已结束(finally 里 endStream),后台异步提取代码引用,不阻塞收尾。
				// 兜底策略:一律调用提取节点补模型没提到的符号;重合部分以模型
				// Answer 为准(见 _extractAndAttachReferences 合并规则)。
				void this._extractAndAttachReferences(
					assistantMessage.id,
					result.answer,
					result.state.loadedWorkspaceItems,
					model,
					controller.signal,
					{
						conversationId: graphConversationId,
						requestId: graphRequestId,
					},
					result.state.answerReferences
				);
			} catch (error) {
				this._recordDiagnostic(
					controller.signal.aborted ? 'turn_cancelled' : 'turn_failed',
					{
						conversationId: graphConversationId,
						requestId: graphRequestId,
					},
					{
						error,
						totalDurationMs: Date.now() - graphStartedAt,
						usage: graphUsage,
						usageByNode: graphUsageByNode,
						assistantMessage: this._state.messages.find(
							(message) => message.id === assistantMessage.id
						),
					}
				);
				if (!controller.signal.aborted) {
					const message = error instanceof Error ? error.message : String(error);
					console.error('ClassMate graph error:', error);
					this._onPerformanceTrace?.('request_failed', {
						requestId: graphRequestId,
						totalDurationMs: Date.now() - graphStartedAt,
						error: message,
						usage: graphUsage,
						usageByNode: graphUsageByNode,
					});
					this.appendToken(assistantMessage.id, `\n\n[Error: ${message}]`);
				}
			} finally {
				if (controller.signal.aborted) {
					this.appendToken(
						assistantMessage.id,
						hasAnswerToken ? '\n\n_已停止生成。_' : '已停止回答。'
					);
				}
				if (this._graphAbortController === controller) {
					this._graphAbortController = undefined;
				}
				this._lastUsageDebug = { total: graphUsage, byNode: graphUsageByNode };
				this.endStream();
			}
			return;
		}

		const request: LLMRequest = {
			messages,
			model: cfg.model,
		};

		const body = adapter.buildRequest(request);

		adapter.streamResponse(body, {
			onToken: (token) => {
				this._setProcessingStage(null);
				this.appendToken(assistantMessage.id, token);
			},
			onUsage: (usage) => {
				this._setMessageUsage(assistantMessage.id, usage);
			},
			onError: (error) => {
				console.error('LLM stream error:', error);
				this.appendToken(assistantMessage.id, `\n\n[Error: ${error.message}]`);
				this.endStream();
			},
			onComplete: () => {
				if (editTarget) {
					this._attachProposedEdit(assistantMessage.id, editTarget);
				}
				this.endStream();
			},
		});
	}

	private async _handleSendMessage(message: Extract<WebviewToExtensionMessage, { type: 'sendMessage' }>): Promise<void> {
		const attachments = await Promise.all((message.attachments ?? []).map(async (attachment) => {
			if (attachment.mimeType !== 'application/pdf' || !attachment.dataUrl) {
				return attachment;
			}
			try {
				const base64 = attachment.dataUrl.replace(/^data:[^;]+;base64,/, '');
				const content = formatPdfExtraction(await extractPdfBuffer(Buffer.from(base64, 'base64')));
				return { ...attachment, content, dataUrl: undefined };
			} catch (error) {
				return {
					...attachment,
					content: `[Unable to parse PDF locally: ${error instanceof Error ? error.message : String(error)}]`,
					dataUrl: undefined,
				};
			}
		}));
		const intent = message.intent ?? (looksLikeCodeEditRequest(message.text) ? 'code_edit' : undefined);
		this.addUserMessage(message.text, { intent, images: message.images, attachments });
		this._recordHintRequested(message.text, intent);
		await this._callLLM(message.text, intent);
	}

	/** Return every effective turn in the current in-memory conversation. */
	private _getConversationHistory(): LLMRequest['messages'] {
		return this._state.messages
			.filter((message) =>
				(message.role === 'user' || message.role === 'assistant') &&
				message.content.trim().length > 0
			)
			.map((message) => ({
				role: message.role,
				content: message.content,
				images: message.images,
				attachments: message.attachments,
			}));
	}

	private async _captureEditTarget(): Promise<Omit<ProposedCodeEdit, 'newText'> | undefined> {
		const reference = this._referenceProvider?.()[0];
		if (!reference) {
			return undefined;
		}
		try {
			const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(reference.uri));
			return { uri: reference.uri, fileName: reference.label, expectedText: document.getText() };
		} catch {
			return undefined;
		}
	}

	private _attachProposedEdit(messageId: string, target: Omit<ProposedCodeEdit, 'newText'>): void {
		const message = this._state.messages.find((item) => item.id === messageId);
		if (!message) {
			return;
		}
		const blocks = [...message.content.matchAll(/```(?:[\w+#.-]+)?\s*\n([\s\S]*?)```/g)];
		const newText = blocks.at(-1)?.[1];
		if (!newText) {
			return;
		}
		this._state = {
			...this._state,
			messages: this._state.messages.map((item) =>
				item.id === messageId ? { ...item, proposedEdit: { ...target, newText } } : item
			),
		};
	}

	private async _applyProposedEdit(messageId: string): Promise<void> {
		const proposed = this._state.messages.find((message) => message.id === messageId)?.proposedEdit;
		if (!proposed) {
			return;
		}
		const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(proposed.uri));
		if (document.getText() !== proposed.expectedText) {
			void vscode.window.showWarningMessage('文件在方案生成后已发生变化，已取消应用，请重新生成修改方案。');
			return;
		}
		const lastLine = document.lineAt(document.lineCount - 1);
		const edit = new vscode.WorkspaceEdit();
		edit.replace(document.uri, new vscode.Range(0, 0, lastLine.lineNumber, lastLine.text.length), proposed.newText);
		if (await vscode.workspace.applyEdit(edit)) {
			// 走 ADD2 统一分组决策:面板 active 时直接落进面板之外的分组(#18 零闪屏)。
			await showTextDocumentRespectingPanels(document);
			void vscode.window.showInformationMessage(`已应用对 ${proposed.fileName} 的修改，请检查后保存。`);
		}
	}

	private _createAdapter(cfg: LLMConfig, apiKey: string | undefined): LLMAdapter | undefined {
		const key = apiKey || '';
		const apiUrl = cfg.apiUrl || undefined;

		switch (cfg.provider) {
			case 'claude':
				return new ClaudeAdapter({
					apiKey: key,
					model: cfg.model,
					baseURL: apiUrl,
				});
			case 'openai':
				return new OpenAIAdapter({
					apiKey: key,
					model: cfg.model,
					baseURL: apiUrl,
				});
			case 'deepseek':
				return new DeepSeekAdapter({
					apiKey: key,
					model: cfg.model,
					baseURL: apiUrl,
				});
			default:
				return undefined;
		}
	}

	private _saveActiveConversation(): void {
		const existing = this._conversationRecords.get(this._state.activeConversationId);
		const now = Date.now();
		const firstUserMessage = this._state.messages.find((message) => message.role === 'user');
		const generatedTitle = firstUserMessage?.content.trim().slice(0, 42) || '新对话';
		this._conversationRecords.set(this._state.activeConversationId, {
			id: this._state.activeConversationId,
			title: existing?.messages.some((message) => message.role === 'user')
				? existing.title
				: generatedTitle,
			createdAt: existing?.createdAt ?? firstUserMessage?.timestamp ?? now,
			updatedAt: this._state.messages.at(-1)?.timestamp ?? now,
			messages: this._state.messages,
			inputDraft: this._state.inputDraft,
		});
	}

	private _syncConversationState(): void {
		this._saveActiveConversation();
		const conversations = [...this._conversationRecords.values()]
			.sort((a, b) => b.updatedAt - a.updatedAt)
			.map(({ id, title, createdAt, updatedAt }) => ({ id, title, createdAt, updatedAt }));
		this._state = { ...this._state, conversations };
		void this._onPersist?.({
			activeConversationId: this._state.activeConversationId,
			conversations: [...this._conversationRecords.values()],
		});
	}

	private _broadcast(message: ExtensionToWebviewMessage, options?: { includeDraft?: boolean }): void {
		let outgoing: ExtensionToWebviewMessage = message;
		if (message.type === 'stateSync') {
			this._syncConversationState();
			// 流期间(appendToken/endStream/_setMessageUsage/_setProcessingStage/_insert*Debug)
			// 默认不再携带 inputDraft,让前端用本地 input 即可,避免 input 被回滚覆盖。
			// 真正"草稿语义变化"的少数路径(setInputDraft/addUserMessage/newConversation/
			// switchConversation/clear)需要显式 includeDraft=true。
			if (options?.includeDraft) {
				outgoing = { type: 'stateSync', state: this._state };
			} else {
				const { inputDraft: _ignored, ...rest } = this._state;
				// 剥离 inputDraft 后,严格意义上不再是完整 ChatState;前端会防御 inputDraft 字段缺失。
				outgoing = { type: 'stateSync', state: rest as unknown as typeof this._state };
			}
		}
		for (const presenter of this._presenters) {
			presenter.postMessage(outgoing);
		}
	}

	private _generateId(): string {
		return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
	}
}
