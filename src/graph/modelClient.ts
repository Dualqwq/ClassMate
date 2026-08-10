import type {
	LLMAdapter,
	LLMCompletionResult,
	LLMMessage,
	LLMRequest,
	LLMTokenUsage,
} from '../llm/types';

export interface GraphModelOptions {
	label?: string;
	temperature?: number;
	maxTokens?: number;
	jsonMode?: boolean;
	thinkingMode?: 'enabled' | 'disabled';
	signal?: AbortSignal;
	/** 仅最终 Answer 使用；提供时强制走适配器的流式接口。 */
	onToken?: (token: string) => void;
}

export interface GraphModelClient {
	complete(messages: LLMMessage[], options?: GraphModelOptions): Promise<LLMCompletionResult>;
}

export class AdapterGraphModelClient implements GraphModelClient {
	constructor(
		private readonly _adapter: LLMAdapter,
		private readonly _model?: string,
		private readonly _onUsage?: (usage: LLMTokenUsage, label?: string) => void,
		private readonly _onRequest?: (messages: LLMMessage[], label?: string) => void
	) {}

	public async complete(
		messages: LLMMessage[],
		options: GraphModelOptions = {}
	): Promise<LLMCompletionResult> {
		if (options.signal?.aborted) {
			throw new Error('ClassMate request was cancelled.');
		}
		const request: LLMRequest = {
			messages,
			model: this._model,
			temperature: options.temperature,
			maxTokens: options.maxTokens,
			jsonMode: options.jsonMode,
			thinkingMode: options.thinkingMode,
		};
		this._onRequest?.(messages, options.label);
		const result = options.onToken
			? await this._completeFromStream(request, options.signal, options.onToken)
			: this._adapter.complete
			? await this._adapter.complete(request)
			: await this._completeFromStream(request, options.signal);
		if (options.signal?.aborted) {
			throw new Error('ClassMate request was cancelled.');
		}
		if (result.usage) {
			this._onUsage?.(result.usage, options.label);
		}
		return result;
	}

	private async _completeFromStream(
		request: LLMRequest,
		signal?: AbortSignal,
		onToken?: (token: string) => void
	): Promise<LLMCompletionResult> {
		return new Promise((resolve, reject) => {
			let content = '';
			let usage: LLMTokenUsage | undefined;
			const onAbort = () => reject(new Error('ClassMate request was cancelled.'));
			signal?.addEventListener('abort', onAbort, { once: true });
			this._adapter.streamResponse(this._adapter.buildRequest(request), {
				onToken: (token) => {
					if (!signal?.aborted) {
						content += token;
						onToken?.(token);
					}
				},
				onUsage: (value) => { usage = value; },
				onError: (error) => {
					signal?.removeEventListener('abort', onAbort);
					reject(error);
				},
				onComplete: () => {
					signal?.removeEventListener('abort', onAbort);
					resolve({ content, usage });
				},
			});
		});
	}
}
