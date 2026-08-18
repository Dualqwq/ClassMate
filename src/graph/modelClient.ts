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

export type GraphModelTrace =
	| {
		phase: 'request';
		callId: string;
		startedAt: number;
		label?: string;
		model?: string;
		messages: LLMMessage[];
		options: {
			temperature?: number;
			maxTokens?: number;
			jsonMode: boolean;
			thinkingMode?: 'enabled' | 'disabled';
			streaming: boolean;
		};
	}
	| {
		phase: 'response';
		callId: string;
		startedAt: number;
		durationMs: number;
		label?: string;
		model?: string;
		content: string;
		usage?: LLMTokenUsage;
	}
	| {
		phase: 'error';
		callId: string;
		startedAt: number;
		durationMs: number;
		label?: string;
		model?: string;
		error: { name: string; message: string; stack?: string };
	};

export class AdapterGraphModelClient implements GraphModelClient {
	private _callSequence = 0;

	constructor(
		private readonly _adapter: LLMAdapter,
		private readonly _model?: string,
		private readonly _onUsage?: (usage: LLMTokenUsage, label?: string) => void,
		private readonly _onRequest?: (messages: LLMMessage[], label?: string) => void,
		private readonly _onTrace?: (trace: GraphModelTrace) => void
	) {}

	private _emitTrace(trace: GraphModelTrace): void {
		try {
			this._onTrace?.(trace);
		} catch (error) {
			console.warn('ClassMate model diagnostics trace failed:', error);
		}
	}

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
		const startedAt = Date.now();
		const callId = `${options.label ?? 'unknown'}-${++this._callSequence}`;
		this._onRequest?.(messages, options.label);
		this._emitTrace({
			phase: 'request',
			callId,
			startedAt,
			label: options.label,
			model: this._model,
			messages,
			options: {
				temperature: options.temperature,
				maxTokens: options.maxTokens,
				jsonMode: options.jsonMode ?? false,
				thinkingMode: options.thinkingMode,
				streaming: Boolean(options.onToken),
			},
		});
		try {
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
			this._emitTrace({
				phase: 'response',
				callId,
				startedAt,
				durationMs: Date.now() - startedAt,
				label: options.label,
				model: this._model,
				content: result.content,
				usage: result.usage,
			});
			return result;
		} catch (error) {
			const normalized = error instanceof Error
				? { name: error.name, message: error.message, stack: error.stack }
				: { name: 'Error', message: String(error) };
			this._emitTrace({
				phase: 'error',
				callId,
				startedAt,
				durationMs: Date.now() - startedAt,
				label: options.label,
				model: this._model,
				error: normalized,
			});
			throw error;
		}
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
