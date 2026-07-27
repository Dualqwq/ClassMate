import { formatDebugLog, formatRawDebugLog } from './debugLogFormatter';
import type { DebugEventIndex } from '../debug/debugJourneyStore';
import * as vscode from 'vscode';
import type { ChatMessage, ChatState, ExtensionToWebviewMessage, LLMConfig, MessageIntent, WebviewPresenter, WebviewToExtensionMessage } from './types';
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

const HINT_INTENTS: MessageIntent[] = [
	'hint',
	'code_explanation',
	'concept_explanation',
	'error_explanation',
	'debug_suggestion',
	'summary',
];

export class ChatSession {
	private static _instance: ChatSession | undefined;

	private _state: ChatState = {
		messages: [],
		inputDraft: '',
		isStreaming: false,
		currentStreamMessageId: null,
	};

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

	public addUserMessage(text: string, options?: { intent?: MessageIntent; isCommandGenerated?: boolean }): ChatMessage {
		const message: ChatMessage = {
			id: this._generateId(),
			role: 'user',
			content: text,
			intent: options?.intent,
			isCommandGenerated: options?.isCommandGenerated,
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

	public clear(): void {
		this._state = {
			messages: [],
			inputDraft: '',
			isStreaming: false,
			currentStreamMessageId: null,
		};
		this._broadcast({ type: 'stateSync', state: this._state });
	}

	public handleWebviewMessage(message: WebviewToExtensionMessage): void {
		switch (message.type) {
			case 'inputDraftChanged':
				this.setInputDraft(message.text);
				break;
			case 'sendMessage':
				this.addUserMessage(message.text, { intent: message.intent });
				this._recordHintRequested(message.text, message.intent);
				void this._callLLM(message.text, message.intent);
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
				messages = [...systemMessages, { role: 'user', content: userText }];
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
				messages = [{ role: 'user', content: userText }];
			}
		} catch (error) {
			console.error('Failed to build system prompt:', error);
			messages = [{ role: 'user', content: userText }];
		}

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
			onError: (error) => {
				console.error('LLM stream error:', error);
				this.appendToken(assistantMessage.id, `\n\n[Error: ${error.message}]`);
				this.endStream();
			},
			onComplete: () => {
				this.endStream();
			},
		});
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

	private _broadcast(message: ExtensionToWebviewMessage): void {
		for (const presenter of this._presenters) {
			presenter.postMessage(message);
		}
	}

	private _generateId(): string {
		return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
	}
}
