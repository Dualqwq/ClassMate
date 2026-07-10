import * as vscode from 'vscode';
import type { ChatMessage, ChatState, ExtensionToWebviewMessage, LLMConfig, MessageIntent, WebviewPresenter, WebviewToExtensionMessage } from './types';
import type { LLMAdapter, LLMRequest, LLMStreamCallbacks } from '../llm/types';
import type { SystemPromptBuilder } from '../prompts/systemPromptBuilder';
import { ClaudeAdapter } from '../llm/ClaudeAdapter';
import { OpenAIAdapter } from '../llm/OpenAIAdapter';
import { DeepSeekAdapter } from '../llm/DeepSeekAdapter';
import { getApiKey } from '../config/apiKey';

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

	public startIntentResponse(intent: MessageIntent, userPrompt?: string): void {
		const prompt = userPrompt ?? `/${intent}`;
		this.addUserMessage(prompt, { intent, isCommandGenerated: true });
		this._onIntent?.(intent);
		// Defer the LLM call by one tick so the webview has time to render the
		// user bubble before the assistant message starts streaming.
		setTimeout(() => void this._callLLM(prompt, intent), 50);
	}

	private async _callLLM(userText: string, frontendIntent?: MessageIntent): Promise<void> {
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

		let messages: LLMRequest['messages'] = [];
		try {
			if (this._promptBuilder) {
				const systemMessages = await this._promptBuilder.build(frontendIntent, userText);
				messages = [...systemMessages, { role: 'user', content: userText }];
			} else {
				messages = [{ role: 'user', content: userText }];
			}
		} catch (error) {
			console.error('Failed to build system prompt:', error);
			messages = [{ role: 'user', content: userText }];
		}

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
