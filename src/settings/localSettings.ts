import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import type { ClassMateTheme } from '../chat/types';

export const LOCAL_TOKEN_SECRET_KEY = 'classmate.localToken';
const THEME_STATE_KEY = 'classmate.theme';

export const DEFAULT_THEME: Required<ClassMateTheme> = {
	userBubbleBackground: '',
	userBubbleForeground: '',
	assistantBubbleBackground: '',
	assistantBubbleForeground: '',
	linkColor: '',
	refFuncColor: '',
	refTypeColor: '',
	refVarColor: '',
	refMacroColor: '',
	refStdColor: '',
	refOtherColor: '',
};

/**
 * 获取或创建本地设置页连接令牌。token 持久化存 SecretStorage,
 * 避免 VS Code 每次重启后浏览器扩展/设置页重新配对。
 */
export async function ensureLocalToken(context: vscode.ExtensionContext): Promise<string> {
	const existing = await context.secrets.get(LOCAL_TOKEN_SECRET_KEY);
	if (existing) {
		return existing;
	}
	const token = generateToken();
	await context.secrets.store(LOCAL_TOKEN_SECRET_KEY, token);
	return token;
}

export async function rotateLocalToken(context: vscode.ExtensionContext): Promise<string> {
	const token = generateToken();
	await context.secrets.store(LOCAL_TOKEN_SECRET_KEY, token);
	return token;
}

function generateToken(): string {
	// 128-bit random hex = 32 characters.
	return randomBytes(16).toString('hex');
}

export async function getThemeSettings(context: vscode.ExtensionContext): Promise<ClassMateTheme> {
	return context.globalState.get<ClassMateTheme>(THEME_STATE_KEY) ?? {};
}

export async function saveThemeSettings(
	context: vscode.ExtensionContext,
	theme: ClassMateTheme
): Promise<void> {
	await context.globalState.update(THEME_STATE_KEY, theme);
}

export function buildLocalSettingsUrl(url: string, token: string): string {
	const separator = url.includes('?') ? '&' : '?';
	return `${url}${separator}t=${encodeURIComponent(token)}`;
}

export async function openLocalSettingsPage(
	context: vscode.ExtensionContext,
	serverUrl: string
): Promise<void> {
	const token = await ensureLocalToken(context);
	const url = buildLocalSettingsUrl(serverUrl, token);
	await vscode.env.openExternal(vscode.Uri.parse(url));
}
