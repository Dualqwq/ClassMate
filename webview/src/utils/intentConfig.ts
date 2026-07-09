import type { MessageIntent } from '../../src/chat/types';

export interface IntentDisplay {
	icon: string;
	label: string;
	accentColor: string;
}

export function getIntentDisplay(intent: MessageIntent): IntentDisplay {
	switch (intent) {
		case 'chat':
			return { icon: '💬', label: 'Chat', accentColor: 'var(--vscode-foreground)' };
		case 'hint':
			return {
				icon: '💡',
				label: 'Hint',
				accentColor: 'var(--vscode-editorLightBulb-foreground, #ddb100)',
			};
		case 'code_explanation':
			return {
				icon: '📝',
				label: 'Code Explanation',
				accentColor: 'var(--vscode-symbolIcon-classForeground, #ee9d28)',
			};
		case 'concept_explanation':
			return {
				icon: '📘',
				label: 'Concept',
				accentColor: 'var(--vscode-symbolIcon-interfaceForeground, #75beff)',
			};
		case 'error_explanation':
			return {
				icon: '⚠️',
				label: 'Error',
				accentColor: 'var(--vscode-editorError-foreground, #f85149)',
			};
		case 'debug_suggestion':
			return {
				icon: '🐛',
				label: 'Debug',
				accentColor: 'var(--vscode-debugIcon-breakpointForeground, #e51400)',
			};
		case 'summary':
			return {
				icon: '📋',
				label: 'Summary',
				accentColor: 'var(--vscode-symbolIcon-enumeratorForeground, #b180d7)',
			};
	}
}
