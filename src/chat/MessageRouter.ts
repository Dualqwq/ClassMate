import type { MessageIntent } from './types';

export type ContainerPreference = 'auto' | 'view' | 'panel';

export function chooseContainer(
	intent: MessageIntent,
	preference: ContainerPreference,
	currentContainer?: 'view' | 'panel'
): 'view' | 'panel' {
	if (preference === 'view') {
		return 'view';
	}
	if (preference === 'panel') {
		return 'panel';
	}

	// preference === 'auto'
	switch (intent) {
		case 'hint':
			return 'view';
		case 'chat':
			// Keep free-form chat in whichever container the user is already using.
			return currentContainer ?? 'view';
		case 'code_explanation':
		case 'concept_explanation':
		case 'error_explanation':
		case 'debug_suggestion':
		case 'summary':
			return 'panel';
		default:
			return currentContainer ?? 'view';
	}
}

export function isLongFormContent(content: string): boolean {
	// Simple heuristic: multi-paragraph, code block, or heading suggests long-form.
	if (content.includes('\n```') || content.includes('## ')) {
		return true;
	}
	const firstParagraph = content.split('\n\n')[0] ?? '';
	return firstParagraph.length > 400;
}
