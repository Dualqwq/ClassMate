import * as vscode from 'vscode';
import type { LLMConfig, LLMProvider } from '../chat/types';

const API_KEY_SECRET_KEY = 'classmate.apiKey';
const PROVIDER_STATE_KEY = 'classmate.llmProvider';
const MODEL_STATE_KEY = 'classmate.llmModel';
const API_URL_STATE_KEY = 'classmate.apiUrl';

export async function getLLMConfig(context: vscode.ExtensionContext): Promise<LLMConfig> {
	const provider = context.globalState.get<LLMProvider>(PROVIDER_STATE_KEY) ?? 'claude';
	const model =
		context.globalState.get<string>(MODEL_STATE_KEY) ?? getDefaultModel(provider);
	const apiKeySet = !!(await context.secrets.get(API_KEY_SECRET_KEY));
	const apiUrl = context.globalState.get<string>(API_URL_STATE_KEY);
	return { provider, model, apiKeySet, apiUrl };
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
