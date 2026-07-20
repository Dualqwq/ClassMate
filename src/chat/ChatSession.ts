import { formatDebugLog, formatRawDebugLog } from './debugLogFormatter';
import type { DebugEventIndex } from '../debug/debugJourneyStore';
import * as vscode from 'vscode';
import type { ChatAttachment, ChatImage, ChatMessage, ChatReference, ChatState, ExtensionToWebviewMessage, LLMConfig, MessageIntent, PersistedChatConversation, PersistedChatData, ProposedCodeEdit, WebviewPresenter, WebviewToExtensionMessage } from './types';
import type { LLMAdapter, LLMRequest, LLMStreamCallbacks } from '../llm/types';
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

function looksLikeCodeEditRequest(text: string): boolean {
	return /(帮我|请|直接)?\s*(修改|改成|改一下|重构|修复|替换)|\b(edit|modify|refactor|change|fix)\b/i.test(text);
}

export class ChatSession {
	private static _instance: ChatSession | undefined;

	private _state: ChatState = {
		messages: [],
		inputDraft: '',
		isStreaming: false,
		currentStreamMessageId: null,
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
	private _onGetApiKey?: () => Promise<string | undefined>;
	private _llmConfig?: LLMConfig;
	private _currentAdapter?: LLMAdapter;
	private _promptBuilder?: SystemPromptBuilder;
	private _debugStore?: DebugJourneyStore;
	private _sessionId?: string;
	private _workspaceId?: string;

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

	private async _insertKnowledgeCards(userText: string): Promise<void> {
		const content = await this._buildKnowledgeCardsContent();
		const message: ChatMessage = {
			id: this._generateId(),
			role: 'system',
			content,
			intent: undefined,
			isKnowledgeCards: true,
			timestamp: Date.now(),
		};

		this._state = {
			...this._state,
			messages: [...this._state.messages, message],
		};
		this._broadcast({ type: 'stateSync', state: this._state });
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

	private async _insertDebugJourney(userText: string): Promise<void> {
		const content = await this._buildDebugJourneyContent();
		const message: ChatMessage = {
			id: this._generateId(),
			role: 'system',
			content,
			intent: undefined,
			isDebugJourney: true,
			timestamp: Date.now(),
		};

		this._state = {
			...this._state,
			messages: [...this._state.messages, message],
		};
		this._broadcast({ type: 'stateSync', state: this._state });
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

	private async _insertDebugLog(userText: string): Promise<void> {
		const content = await this._buildDebugLogContent();
		const message: ChatMessage = {
			id: this._generateId(),
			role: 'system',
			content,
			intent: undefined,
			isDebugLog: true,
			timestamp: Date.now(),
		};

		this._state = {
			...this._state,
			messages: [...this._state.messages, message],
		};
		this._broadcast({ type: 'stateSync', state: this._state });
	}

	private async _insertRawDebugLog(userText: string): Promise<void> {
		const content = await this._buildRawDebugLogContent();
		const message: ChatMessage = {
			id: this._generateId(),
			role: 'system',
			content,
			intent: undefined,
			isDebugRawLog: true,
			timestamp: Date.now(),
		};

		this._state = {
			...this._state,
			messages: [...this._state.messages, message],
		};
		this._broadcast({ type: 'stateSync', state: this._state });
	}

	private _insertSystemPromptDebug(systemMessages: LLMRequest['messages'], userText: string): void {
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

		this._state = {
			...this._state,
			messages: [...this._state.messages, message],
		};
		this._broadcast({ type: 'stateSync', state: this._state });
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

	public setPromptBuilder(builder: SystemPromptBuilder): void {
		this._promptBuilder = builder;
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

	public static resetInstance(): void {
		ChatSession._instance = undefined;
	}

	public attach(presenter: WebviewPresenter): void {
		this._presenters.add(presenter);
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
		this._state = { ...this._state, inputDraft: text };
		this._broadcast({ type: 'stateSync', state: this._state });
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
		this._broadcast({ type: 'stateSync', state: this._state });
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

	public endStream(): void {
		const endedId = this._state.currentStreamMessageId;
		this._state = {
			...this._state,
			isStreaming: false,
			currentStreamMessageId: null,
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
			activeConversationId: createConversationId(),
			conversations: this._state.conversations,
		};
		this._broadcast({ type: 'stateSync', state: this._state });
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
			activeConversationId: target.id,
			conversations: this._state.conversations,
		};
		this._broadcast({ type: 'stateSync', state: this._state });
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

	public clear(): void {
		this._state = {
			messages: [],
			inputDraft: '',
			isStreaming: false,
			currentStreamMessageId: null,
			activeConversationId: this._state.activeConversationId,
			conversations: this._state.conversations,
		};
		this._broadcast({ type: 'stateSync', state: this._state });
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
			case 'newConversation':
				this.newConversation();
				break;
			case 'switchConversation':
				this.switchConversation(message.conversationId);
				break;
			case 'openReference':
				this._onOpenReference?.(message.reference);
				break;
			case 'applyProposedEdit':
				void this._applyProposedEdit(message.messageId);
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
		let messages: LLMRequest['messages'] = [];
		try {
			if (this._promptBuilder) {
				const systemMessages = await this._promptBuilder.build(frontendIntent, userText);
				messages = [...systemMessages, ...this._getConversationHistory()];
				if (userText.trim() === '//show-prompt') {
					this._insertSystemPromptDebug(systemMessages, userText);
					return;
				}
				if (userText.trim() === '//show-log') {
					await this._insertDebugLog(userText);
					return;
				}
				if (userText.trim() === '//show-raw-log') {
					await this._insertRawDebugLog(userText);
					return;
				}
				if (userText.trim() === '//knowledge-cards') {
					await this._insertKnowledgeCards(userText);
					return;
				}
				if (userText.trim() === '//show-journey') {
					await this._insertDebugJourney(userText);
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

		const request: LLMRequest = {
			messages,
			model: cfg.model,
		};

		const body = adapter.buildRequest(request);

		adapter.streamResponse(body, {
			onToken: (token) => {
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
			await vscode.window.showTextDocument(document);
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

	private _broadcast(message: ExtensionToWebviewMessage): void {
		let outgoing = message;
		if (message.type === 'stateSync') {
			this._syncConversationState();
			outgoing = { type: 'stateSync', state: this._state };
		}
		for (const presenter of this._presenters) {
			presenter.postMessage(outgoing);
		}
	}

	private _generateId(): string {
		return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
	}
}
