import * as vscode from 'vscode';
import type { LLMConfig, LLMProvider } from '../chat/types';

const API_KEY_SECRET_KEY = 'classmate.apiKey';
const PROVIDER_STATE_KEY = 'classmate.llmProvider';
const MODEL_STATE_KEY = 'classmate.llmModel';
const API_URL_STATE_KEY = 'classmate.apiUrl';
const FALLBACK_API_KEY_SECRET_KEY = 'classmate.fallbackApiKey';
const FALLBACK_PROVIDER_STATE_KEY = 'classmate.fallbackLlmProvider';
const FALLBACK_MODEL_STATE_KEY = 'classmate.fallbackLlmModel';
const FALLBACK_API_URL_STATE_KEY = 'classmate.fallbackApiUrl';

export async function getLLMConfig(context: vscode.ExtensionContext): Promise<LLMConfig> {
	const provider = context.globalState.get<LLMProvider>(PROVIDER_STATE_KEY) ?? 'claude';
	const model =
		context.globalState.get<string>(MODEL_STATE_KEY) ?? getDefaultModel(provider);
	const apiKeySet = !!(await context.secrets.get(API_KEY_SECRET_KEY));
	const apiUrl = context.globalState.get<string>(API_URL_STATE_KEY);
	const fallback = await getFallbackLLMConfig(context);
	return {
		provider,
		model,
		apiKeySet,
		apiUrl,
		...(fallback ? { fallback } : {}),
	};
}

export async function saveLLMConfig(
	context: vscode.ExtensionContext,
	provider: LLMProvider,
	model: string,
	apiKey?: string,
	apiUrl?: string
): Promise<void> {
	await context.globalState.update(PROVIDER_STATE_KEY, provider);
	await context.globalState.update(MODEL_STATE_KEY, model);
	await context.globalState.update(API_URL_STATE_KEY, apiUrl?.trim() || undefined);

	if (apiKey === undefined || apiKey.trim().length === 0) {
		// An empty/undefined key means the user wants to keep the existing key.
		// Do nothing; SecretStorage is left untouched.
		return;
	}

	await context.secrets.store(API_KEY_SECRET_KEY, apiKey.trim());
}

function getDefaultModel(provider: LLMProvider): string {
	switch (provider) {
		case 'claude':
			return 'claude-sonnet-4-7-20251001';
		case 'openai':
			return 'gpt-4.1';
		case 'deepseek':
			return 'deepseek-chat';
	}
}

export interface FallbackLLMConfigInput {
	provider: LLMProvider;
	model: string;
	apiKey?: string;
	apiUrl?: string;
}

/**
 * 备用 provider 只在用户显式配置后存在;任何字段都没有时返回 undefined,
 * 恢复通道随之不启用(没有隐式默认备用)。
 */
export async function getFallbackLLMConfig(
	context: vscode.ExtensionContext
): Promise<LLMConfig | undefined> {
	const provider = context.globalState.get<LLMProvider>(FALLBACK_PROVIDER_STATE_KEY);
	if (!provider) {
		return undefined;
	}
	const model =
		context.globalState.get<string>(FALLBACK_MODEL_STATE_KEY) ?? getDefaultModel(provider);
	const apiKeySet = !!(await context.secrets.get(FALLBACK_API_KEY_SECRET_KEY));
	const apiUrl = context.globalState.get<string>(FALLBACK_API_URL_STATE_KEY);
	return { provider, model, apiKeySet, apiUrl };
}

/**
 * 保存备用 provider 配置。input 为 null 表示清除备用配置;
 * apiKey 留空表示保留已存的 key(与主配置行为一致)。
 */
export async function saveFallbackLLMConfig(
	context: vscode.ExtensionContext,
	input: FallbackLLMConfigInput | null
): Promise<void> {
	if (!input) {
		await context.globalState.update(FALLBACK_PROVIDER_STATE_KEY, undefined);
		await context.globalState.update(FALLBACK_MODEL_STATE_KEY, undefined);
		await context.globalState.update(FALLBACK_API_URL_STATE_KEY, undefined);
		await context.secrets.delete(FALLBACK_API_KEY_SECRET_KEY);
		return;
	}
	await context.globalState.update(FALLBACK_PROVIDER_STATE_KEY, input.provider);
	await context.globalState.update(FALLBACK_MODEL_STATE_KEY, input.model);
	await context.globalState.update(FALLBACK_API_URL_STATE_KEY, input.apiUrl?.trim() || undefined);
	if (input.apiKey === undefined || input.apiKey.trim().length === 0) {
		return;
	}
	await context.secrets.store(FALLBACK_API_KEY_SECRET_KEY, input.apiKey.trim());
}

export async function getFallbackApiKey(context: vscode.ExtensionContext): Promise<string | undefined> {
	return context.secrets.get(FALLBACK_API_KEY_SECRET_KEY);
}
