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
	| 'summary'
	| 'code_edit';

export interface ChatMessage {
	id: string;
	role: MessageRole;
	content: string;
	intent?: MessageIntent;
	isCommandGenerated?: boolean;
	isSystemPromptDebug?: boolean;
	isDebugLog?: boolean;
	isDebugRawLog?: boolean;
	isDebugJourney?: boolean;
	isKnowledgeCards?: boolean;
	timestamp: number;
	usage?: import('../llm/types').LLMTokenUsage;
	references?: ChatReference[];
	images?: ChatImage[];
	attachments?: ChatAttachment[];
	proposedEdit?: ProposedCodeEdit;
}

export interface ChatImage {
	name: string;
	mimeType: string;
	dataUrl: string;
}

export interface ChatAttachment {
	name: string;
	mimeType: string;
	size: number;
	content?: string;
	dataUrl?: string;
}

export interface ProposedCodeEdit {
	uri: string;
	fileName: string;
	newText: string;
	expectedText: string;
}

export interface ChatReference {
	label: string;
	uri: string;
	startLine?: number;
	endLine?: number;
}

export interface ChatConversationSummary {
	id: string;
	title: string;
	createdAt: number;
	updatedAt: number;
}

export interface PersistedChatConversation extends ChatConversationSummary {
	messages: ChatMessage[];
	inputDraft: string;
}

export interface PersistedChatData {
	activeConversationId: string;
	conversations: PersistedChatConversation[];
}

export interface ChatState {
	messages: ChatMessage[];
	inputDraft: string;
	isStreaming: boolean;
	currentStreamMessageId: string | null;
	activeConversationId: string;
	conversations: ChatConversationSummary[];
}

export interface WebviewPresenter {
	postMessage(message: unknown): void;
	dispose(): void;
}

// Messages sent from the webview frontend to the extension host.
export type WebviewToExtensionMessage =
	| { type: 'sendMessage'; text: string; intent?: MessageIntent; images?: ChatImage[]; attachments?: ChatAttachment[] }
	| { type: 'inputDraftChanged'; text: string }
	| { type: 'requestContainerToggle' }
	| { type: 'requestLLMConfig' }
	| { type: 'saveLLMConfig'; provider: LLMProvider; model: string; apiKey?: string; apiUrl?: string }
	| { type: 'newConversation' }
	| { type: 'switchConversation'; conversationId: string }
	| { type: 'openReference'; reference: ChatReference }
	| { type: 'applyProposedEdit'; messageId: string };

// Messages sent from the extension host to the webview frontend.
export type ExtensionToWebviewMessage =
	| { type: 'stateSync'; state: ChatState }
	| { type: 'appendToken'; messageId: string; token: string }
	| { type: 'streamStart'; message: ChatMessage }
	| { type: 'streamEnd'; messageId: string }
	| { type: 'containerInfo'; container: 'view' | 'panel' }
	| { type: 'llmConfig'; config: LLMConfig };
