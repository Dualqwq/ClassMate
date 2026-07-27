import type { LLMMessage } from './types';

/** Append readable attachment contents without changing the visible chat text. */
export function buildTextWithAttachments(message: LLMMessage): string {
	if (!message.attachments?.length) {
		return message.content;
	}
	const sections = message.attachments.map((attachment) => {
		const header = `--- Attached file: ${attachment.name} (${attachment.mimeType || 'unknown'}, ${attachment.size} bytes) ---`;
		return attachment.content !== undefined
			? `${header}\n${attachment.content}`
			: `${header}\n[Binary attachment metadata only; content is not available to this chat model.]`;
	});
	return `${message.content}\n\n${sections.join('\n\n')}`;
}
