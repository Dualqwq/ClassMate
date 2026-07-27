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

export interface LLMTokenUsage {
	/** Tokens consumed by the prompt / input messages. */
	inputTokens: number;
	/** Tokens consumed by the model's output. */
	outputTokens: number;
	/** Total tokens when reported by the provider. */
	totalTokens?: number;
}

export interface LLMCompletionResult {
	/** Generated text content. */
	content: string;
	/** Token usage as reported by the provider, when available. */
	usage?: LLMTokenUsage;
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

	/**
	 * Optional non-streaming completion.
	 * Adapters that implement this avoid the overhead of token-by-token
	 * aggregation for one-shot tasks like exporting a debug notebook.
	 *
	 * The returned object should include the generated content and, when
	 * available, actual token usage from the provider.
	 */
	complete?(req: LLMRequest): Promise<LLMCompletionResult>;
}
