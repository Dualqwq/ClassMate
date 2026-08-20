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
			// 非流式路径同样随 abort 拆断底层 HTTP:外层的 aborted
			// 检查只拦"下一次调用",拦不住挂起中的请求(run17 取证:
			// 一轮取消后挂了 700 秒才被服务端断流)。
			signal: options.signal,
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
			this._adapter.streamResponse(
				this._adapter.buildRequest(request),
				{
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
				},
				// 传给适配器:SDK 收到 signal 才会拆断挂起的 HTTP 流,
				// 否则 abort 只 reject 这层 Promise,底层请求继续跑到超时。
				signal
			);
		});
	}
}

export interface FallbackModelClientOptions {
	/** 主 client(常规调用一律走它)。 */
	primary: GraphModelClient;
	/** 备用 client;仅在主 client 抛错时使用。 */
	fallback: GraphModelClient;
	/**
	 * 整个 client 生命周期内最多切换到备用的调用次数(默认 1)。
	 * 图内 R1 重试会再次经过本 client:主→备都失败才向上抛,
	 * 抛出后计一次;超过上限后不再尝试备用(避免雪崩时双倍放大流量)。
	 */
	maxFallbackCalls?: number;
	/** 切换事件回调(诊断/eval 记录用)。 */
	onFallbackUsed?: (info: { label?: string; attempt: number; error: string }) => void;
}

/**
 * 7.8 恢复通道:主 provider 失败时按次切换备用 provider(显式配置才存在)。
 * 只包 GraphModelClient 这一层:主 client 成功时行为与原来逐字节一致;
 * 失败且未超上限时用备用 client 重发同一请求,usage/trace 由两个底层
 * client 各自上报。
 */
export class FallbackGraphModelClient implements GraphModelClient {
	private _fallbackCalls = 0;

	constructor(private readonly _options: FallbackModelClientOptions) {}

	public async complete(
		messages: LLMMessage[],
		options: GraphModelOptions = {}
	): Promise<LLMCompletionResult> {
		try {
			return await this._options.primary.complete(messages, options);
		} catch (error) {
			if (options.signal?.aborted) {
				throw error;
			}
			const max = this._options.maxFallbackCalls ?? 1;
			if (this._fallbackCalls >= max) {
				throw error;
			}
			this._fallbackCalls++;
			const message = error instanceof Error ? error.message : String(error);
			this._options.onFallbackUsed?.({
				label: options.label,
				attempt: this._fallbackCalls,
				error: message,
			});
			return this._options.fallback.complete(messages, options);
		}
	}
}
