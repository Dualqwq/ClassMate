import * as vscode from 'vscode';

export const API_KEY_SECRET_KEY = 'classmate.apiKey';

/**
 * Read the stored API key from VS Code SecretStorage.
 * Returns undefined if no key has been stored.
 */
export async function getApiKey(context: vscode.ExtensionContext): Promise<string | undefined> {
	return context.secrets.get(API_KEY_SECRET_KEY);
}

/**
 * Prompt the user for an API key and store it securely in SecretStorage.
 * The key is never written to settings.json or any other plaintext file.
 */
export async function setupApiKey(context: vscode.ExtensionContext): Promise<void> {
	const key = await vscode.window.showInputBox({
		prompt: 'Enter your ClassMate API key',
		placeHolder: 'sk-...',
		password: true,
		ignoreFocusOut: true,
		validateInput: (value) => {
			if (!value || value.trim().length === 0) {
				return 'API key cannot be empty.';
			}
			return undefined;
		},
	});

	if (key === undefined) {
		// User cancelled the input.
		return;
	}

	await context.secrets.store(API_KEY_SECRET_KEY, key.trim());
	void vscode.window.showInformationMessage('ClassMate API key has been saved securely.');
}

/**
 * Delete the stored API key. Useful for a "sign out" or reset flow.
 */
export async function deleteApiKey(context: vscode.ExtensionContext): Promise<void> {
	await context.secrets.delete(API_KEY_SECRET_KEY);
	void vscode.window.showInformationMessage('ClassMate API key has been removed.');
}
