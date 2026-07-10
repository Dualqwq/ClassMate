import { OpenAIAdapter } from './OpenAIAdapter';
import type { LLMAdapter, LLMRequest, LLMStreamCallbacks } from './types';

export interface DeepSeekAdapterOptions {
	apiKey: string;
	model?: string;
	baseURL?: string;
}

/**
 * DeepSeek uses the OpenAI-compatible Chat Completions API, so we wrap
 * OpenAIAdapter and only change the defaults.
 */
export class DeepSeekAdapter implements LLMAdapter {
	public readonly name = 'DeepSeek';

	private readonly _adapter: OpenAIAdapter;

	constructor(options: DeepSeekAdapterOptions) {
		this._adapter = new OpenAIAdapter({
			apiKey: options.apiKey,
			model: options.model ?? 'deepseek-chat',
			baseURL: options.baseURL ?? 'https://api.deepseek.com/v1',
		});
	}

	public buildRequest(req: LLMRequest): unknown {
		return this._adapter.buildRequest(req);
	}

	public streamResponse(request: unknown, callbacks: LLMStreamCallbacks): void {
		return this._adapter.streamResponse(request, callbacks);
	}
}
