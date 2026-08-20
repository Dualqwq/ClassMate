import type { LLMAdapter, LLMCompletionResult, LLMMessage, LLMRequest, LLMStreamCallbacks } from './types';
import { buildTextWithAttachments } from './messageContent';

// We avoid importing the full Anthropic SDK at the top level so this file can
// be parsed even if the dependency is missing. The SDK is loaded lazily inside
// streamResponse.
//
// Future: Claude has a native beta "skills" feature (container.skills) that
// requires the code_execution tool and beta headers. If ClassMate later decides
// to bind only to Claude, skill files could be uploaded via
// client.beta.skills.create(...) and referenced by ID. For now we keep the
// implementation provider-agnostic by injecting skill content as system blocks.
type AnthropicSDK = any;

export interface ClaudeAdapterOptions {
	apiKey: string;
	model?: string;
	baseURL?: string;
}

export class ClaudeAdapter implements LLMAdapter {
	public readonly name = 'Claude';

	private readonly _apiKey: string;
	private readonly _model: string;
	private readonly _baseURL?: string;

	constructor(options: ClaudeAdapterOptions) {
		this._apiKey = options.apiKey;
		this._model = options.model ?? 'claude-sonnet-4-7-20251001';
		this._baseURL = options.baseURL;
	}

	public buildRequest(req: LLMRequest): unknown {
		const systemBlocks = this._buildSystemBlocks(req.messages);
		const conversationMessages = req.messages
			.filter((m): m is LLMMessage & { role: 'user' | 'assistant' } => m.role !== 'system')
			.map((m) => ({
				role: m.role,
				content: m.images?.length
					? [
						{ type: 'text', text: buildTextWithAttachments(m) },
						...m.images.map((image) => ({
							type: 'image',
							source: {
								type: 'base64',
								media_type: image.mimeType,
								data: image.dataUrl.replace(/^data:[^;]+;base64,/, ''),
							},
						})),
					]
					: buildTextWithAttachments(m),
			}));

		const body: Record<string, unknown> = {
			model: req.model ?? this._model,
			max_tokens: req.maxTokens ?? 4096,
			messages: conversationMessages,
			stream: true,
		};

		if (systemBlocks.length > 0) {
			body.system = systemBlocks;
		}

		if (req.temperature !== undefined) {
			body.temperature = req.temperature;
		}

		return body;
	}

	public streamResponse(
		request: unknown,
		callbacks: LLMStreamCallbacks,
		signal?: AbortSignal
	): void {
		const Anthropic = this._loadSDK();
		const client = new Anthropic({
			apiKey: this._apiKey,
			baseURL: this._baseURL,
		});

		// The Anthropic SDK can accept the raw request body for streaming.
		const stream = client.messages.create(request as Record<string, unknown>, {
			signal,
		});

		this._consumeStream(stream, callbacks, signal);
	}

	public async complete(req: LLMRequest): Promise<LLMCompletionResult> {
		const Anthropic = this._loadSDK();
		const client = new Anthropic({
			apiKey: this._apiKey,
			baseURL: this._baseURL,
		});

		const requestBody = { ...(this.buildRequest(req) as Record<string, unknown>), stream: false };
		const response = await client.messages.create(requestBody, {
			signal: req.signal,
		});

		const content = response.content;
		const text = Array.isArray(content) && content.length > 0 ? content[0].text ?? '' : '';

		const usage = response.usage;
		if (usage && typeof usage === 'object') {
			return {
				content: text,
				usage: {
					inputTokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : 0,
					outputTokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : 0,
					totalTokens: typeof usage.total_tokens === 'number' ? usage.total_tokens : undefined,
				},
			};
		}

		return { content: text };
	}

	private async _consumeStream(
		stream: Promise<AsyncIterable<any>>,
		callbacks: LLMStreamCallbacks,
		signal?: AbortSignal
	): Promise<void> {
		try {
			for await (const event of await stream) {
				if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
					callbacks.onToken(event.delta.text ?? '');
				}
			}
			callbacks.onComplete?.();
		} catch (error) {
			// signal 由 SDK 拆断:统一按取消上抛,避免旧 SDK 版本把
			// abort 包装成普通错误混入 provider 失败统计。
			if (signal?.aborted) {
				callbacks.onError?.(new Error('ClassMate request was cancelled.'));
				return;
			}
			callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
		}
	}

	private _buildSystemBlocks(messages: LLMMessage[]): unknown[] {
		const systemMessages = messages.filter((m) => m.role === 'system');
		if (systemMessages.length === 0) {
			return [];
		}

		// Place cache_control on the last system block so the stable teaching
		// methodology / few-shot examples are cached. Dynamic context after the
		// breakpoint should not be cached.
		return systemMessages.map((m, index) => {
			const isLast = index === systemMessages.length - 1;
			const block: Record<string, unknown> = {
				type: 'text',
				text: m.content,
			};
			if (isLast) {
				block.cache_control = { type: 'ephemeral' };
			}
			return block;
		});
	}

	private _loadSDK(): AnthropicSDK {
		try {
			return require('@anthropic-ai/sdk');
		} catch {
			throw new Error(
				'Anthropic SDK is not installed. Please run "npm install @anthropic-ai/sdk" in code/classmate/.'
			);
		}
	}
}
