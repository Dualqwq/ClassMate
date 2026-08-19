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
	/** 只展示本轮实际使用的工作区文件，不暴露内部 Skill 或知识卡片。 */
	contextSummary?: ChatContextSummary;
	/** 调试用:引用提取时的工作区极简清单(文件 → 符号),随消息持久化。 */
	referenceDebug?: {
		files: Array<{
			path: string;
			symbols: Array<{ name: string; lines: Array<{ line: number; text: string }> }>;
		}>;
	};
}

export interface ChatContextSummary {
	workspaceFiles: string[];
	/** 本轮实际加载的 C/C++ 代码文件相对路径;渲染层文件名补链目录。 */
	codeFiles?: string[];
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

/** 行内代码的语义类型(任务 7):决定着色;本地正则证据优先于 LLM 提议。 */
export type ReferenceKind = 'func' | 'type' | 'var' | 'macro' | 'std' | 'other';

export interface ChatReference {
	label: string;
	uri: string;
	startLine?: number;
	endLine?: number;
	/** 符号/函数名;无行号时用于打开后定位。 */
	symbol?: string;
	/** 语义类型,无 kind 时渲染层用本地规则兜底(中性色)。 */
	kind?: ReferenceKind;
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
	processingStage: string | null;
	/** 正在为哪个 assistant 消息提取代码引用(用于显示进度小字)。 */
	referenceExtractionPendingFor?: string | null;
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
	| { type: 'deleteConversation'; conversationId: string }
	| { type: 'openReference'; reference: ChatReference; inferred?: boolean }
	| { type: 'applyProposedEdit'; messageId: string }
	| { type: 'cancelResponse' };

// Messages sent from the extension host to the webview frontend.
export type ExtensionToWebviewMessage =
	| { type: 'stateSync'; state: ChatState }
	| { type: 'appendToken'; messageId: string; token: string }
	| { type: 'streamStart'; message: ChatMessage }
	| { type: 'streamEnd'; messageId: string }
	| { type: 'containerInfo'; container: 'view' | 'panel' }
	| { type: 'llmConfig'; config: LLMConfig };
