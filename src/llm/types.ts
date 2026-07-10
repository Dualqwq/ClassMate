// LLM adapter contract used by ClassMate.
// Concrete adapters (Claude, DeepSeek, etc.) must implement this interface.

export type LLMRole = 'system' | 'user' | 'assistant';

export interface LLMMessage {
	role: LLMRole;
	content: string;
}

export interface LLMRequest {
	messages: LLMMessage[];
	model?: string;
	temperature?: number;
	maxTokens?: number;
}

export interface LLMStreamCallbacks {
	onToken: (token: string) => void;
	onError?: (error: Error) => void;
	onComplete?: () => void;
}

export interface LLMAdapter {
	/** Human-readable adapter name (for logs and UI). */
	readonly name: string;

	/** Build the raw request payload from ClassMate's normalized request. */
	buildRequest(req: LLMRequest): unknown;

	/**
	 * Start a streaming response.
	 * The adapter must call `onToken` for every chunk, `onComplete` when the
	 * stream ends, and `onError` if anything goes wrong.
	 */
	streamResponse(request: unknown, callbacks: LLMStreamCallbacks): void;
}
