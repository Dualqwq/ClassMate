import * as vscode from 'vscode';
import type { ChatMessage, ChatState, ExtensionToWebviewMessage, MessageIntent, WebviewPresenter, WebviewToExtensionMessage } from './types';

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

	public static getInstance(): ChatSession {
		if (!ChatSession._instance) {
			ChatSession._instance = new ChatSession();
		}
		return ChatSession._instance;
	}

	public setOnIntent(callback: (intent: MessageIntent) => void): void {
		this._onIntent = callback;
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

	public addUserMessage(text: string): ChatMessage {
		const message: ChatMessage = {
			id: this._generateId(),
			role: 'user',
			content: text,
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
				// TODO: wire up to LLM adapter in later tasks.
				this.addUserMessage(message.text);
				this._simulateAssistantResponse(message.intent ?? 'chat');
				break;
			case 'requestContainerToggle':
				// The extension host decides actual container switching.
				void vscode.commands.executeCommand('classmate.toggleChatContainer');
				break;
			default:
				console.log('Unhandled webview message:', message);
		}
	}

	private _simulateAssistantResponse(intent: MessageIntent = 'chat'): void {
		// Temporary stub that streams a placeholder response after a short delay.
		// This will be replaced by the real LLM adapter in later tasks.
		const assistantMessage = this.startAssistantMessage(intent);
		this._onIntent?.(intent);
		const text = 'Hello! This is a placeholder response.';
		const tokens = text.split(/(?=\s)|(?<=\s)/).filter(Boolean);
		let index = 0;
		const interval = setInterval(() => {
			if (index < tokens.length) {
				this.appendToken(assistantMessage.id, tokens[index]);
				index++;
			} else {
				clearInterval(interval);
				this.endStream();
			}
		}, 120);
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
