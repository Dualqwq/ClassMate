export type LLMProvider = 'claude' | 'openai' | 'deepseek';

export interface LLMConfig {
	provider: LLMProvider;
	model: string;
	apiKeySet: boolean;
	apiUrl?: string;
}

export type MessageRole = 'user' | 'assistant' | 'system';

export type MessageIntent =
	| 'chat'
	| 'hint'
	| 'code_explanation'
	| 'concept_explanation'
	| 'error_explanation'
	| 'debug_suggestion'
	| 'summary';

export interface ChatMessage {
	id: string;
	role: MessageRole;
	content: string;
	intent?: MessageIntent;
	isCommandGenerated?: boolean;
	isSystemPromptDebug?: boolean;
	isDebugLog?: boolean;
	isDebugJourney?: boolean;
	timestamp: number;
}

export interface ChatState {
	messages: ChatMessage[];
	inputDraft: string;
	isStreaming: boolean;
	currentStreamMessageId: string | null;
}

export interface WebviewPresenter {
	postMessage(message: unknown): void;
	dispose(): void;
}

// Messages sent from the webview frontend to the extension host.
export type WebviewToExtensionMessage =
	| { type: 'sendMessage'; text: string; intent?: MessageIntent }
	| { type: 'inputDraftChanged'; text: string }
	| { type: 'requestContainerToggle' }
	| { type: 'requestLLMConfig' }
	| { type: 'saveLLMConfig'; provider: LLMProvider; model: string; apiKey?: string; apiUrl?: string };

// Messages sent from the extension host to the webview frontend.
export type ExtensionToWebviewMessage =
	| { type: 'stateSync'; state: ChatState }
	| { type: 'appendToken'; messageId: string; token: string }
	| { type: 'streamStart'; message: ChatMessage }
	| { type: 'streamEnd'; messageId: string }
	| { type: 'containerInfo'; container: 'view' | 'panel' }
	| { type: 'llmConfig'; config: LLMConfig };
