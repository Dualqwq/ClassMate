import * as vscode from 'vscode';

const CONFIG_SECTION = 'classmate';
const ENABLED_LANGUAGES_KEY = 'enabledLanguages';

/**
 * Read the user-configured list of enabled language identifiers.
 * Defaults to ["cpp"] so existing C++ workflows keep working out of the box.
 */
export function getEnabledLanguages(): string[] {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const languages = config.get<string[]>(ENABLED_LANGUAGES_KEY);
	if (Array.isArray(languages) && languages.length > 0) {
		return languages.map((lang) => lang.toLowerCase().trim()).filter(Boolean);
	}
	return ['cpp'];
}

/**
 * Check whether a given language identifier is enabled for ClassMate features.
 */
export function isLanguageEnabled(languageId: string | undefined): boolean {
	if (!languageId) {
		return false;
	}
	return getEnabledLanguages().includes(languageId.toLowerCase());
}

/**
 * Watch for enabledLanguages changes and invoke the callback.
 */
export function onEnabledLanguagesChanged(
	callback: () => void,
	thisArgs?: unknown,
	disposables?: vscode.Disposable[]
): vscode.Disposable {
	return vscode.workspace.onDidChangeConfiguration(
		(event) => {
			if (event.affectsConfiguration(`${CONFIG_SECTION}.${ENABLED_LANGUAGES_KEY}`)) {
				callback();
			}
		},
		thisArgs,
		disposables
	);
}
