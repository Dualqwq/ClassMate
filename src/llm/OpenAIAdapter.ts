import type { LLMAdapter, LLMRequest, LLMStreamCallbacks } from './types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OpenAISDK = any;

export interface OpenAIAdapterOptions {
	apiKey: string;
	model?: string;
	baseURL?: string;
}

export class OpenAIAdapter implements LLMAdapter {
	public readonly name = 'OpenAI';

	private readonly _apiKey: string;
	private readonly _model: string;
	private readonly _baseURL?: string;

	constructor(options: OpenAIAdapterOptions) {
		this._apiKey = options.apiKey;
		this._model = options.model ?? 'gpt-4.1';
		this._baseURL = options.baseURL;
	}

	public buildRequest(req: LLMRequest): unknown {
		return {
			model: req.model ?? this._model,
			messages: req.messages.map((m) => ({
				role: m.role,
				content: m.content,
			})),
			stream: true,
			max_tokens: req.maxTokens ?? 4096,
			...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
		};
	}

	public streamResponse(request: unknown, callbacks: LLMStreamCallbacks): void {
		const OpenAI = this._loadSDK();
		const client = new OpenAI({
			apiKey: this._apiKey,
			baseURL: this._baseURL,
		});

		void this._doStream(client, request as Record<string, unknown>, callbacks);
	}

	private async _doStream(
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		client: any,
		requestBody: Record<string, unknown>,
		callbacks: LLMStreamCallbacks
	): Promise<void> {
		try {
			const stream = await client.chat.completions.create(requestBody);
			for await (const chunk of stream) {
				const delta = chunk.choices?.[0]?.delta?.content;
				if (delta) {
					callbacks.onToken(delta);
				}
			}
			callbacks.onComplete?.();
		} catch (error) {
			callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
		}
	}

	private _loadSDK(): OpenAISDK {
		try {
			// eslint-disable-next-line @typescript-eslint/no-var-requires
			return require('openai');
		} catch {
			throw new Error(
				'OpenAI SDK is not installed. Please run "npm install openai" in code/classmate/.'
			);
		}
	}
}
