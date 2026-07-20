import type { LLMAdapter, LLMCompletionResult, LLMRequest, LLMStreamCallbacks, LLMTokenUsage } from './types';
import { buildTextWithAttachments } from './messageContent';

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
				content: m.images?.length
					? [
						{ type: 'text', text: buildTextWithAttachments(m) },
						...m.images.map((image) => ({
							type: 'image_url',
							image_url: { url: image.dataUrl },
						})),
					]
					: buildTextWithAttachments(m),
			})),
			stream: true,
			stream_options: { include_usage: true },
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

	public async complete(req: LLMRequest): Promise<LLMCompletionResult> {
		const OpenAI = this._loadSDK();
		const client = new OpenAI({
			apiKey: this._apiKey,
			baseURL: this._baseURL,
		});

		const requestBody: Record<string, unknown> = {
			...(this.buildRequest(req) as Record<string, unknown>),
			stream: false,
		};
		delete requestBody.stream_options;
		const response = await client.chat.completions.create(requestBody);

		const message = response.choices?.[0]?.message;
		const text = typeof message?.content === 'string' ? message.content : '';

		const usage = normalizeOpenAIUsage(response.usage);
		if (usage) {
			return {
				content: text,
				usage,
			};
		}

		return { content: text };
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
				const usage = normalizeOpenAIUsage(chunk.usage);
				if (usage) {
					callbacks.onUsage?.(usage);
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

/** Normalize OpenAI-compatible usage, including DeepSeek cache statistics. */
export function normalizeOpenAIUsage(value: unknown): LLMTokenUsage | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const usage = value as Record<string, unknown>;
	return {
		inputTokens: typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0,
		outputTokens: typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0,
		totalTokens: typeof usage.total_tokens === 'number' ? usage.total_tokens : undefined,
		cacheHitTokens: typeof usage.prompt_cache_hit_tokens === 'number'
			? usage.prompt_cache_hit_tokens
			: undefined,
		cacheMissTokens: typeof usage.prompt_cache_miss_tokens === 'number'
			? usage.prompt_cache_miss_tokens
			: undefined,
	};
}
