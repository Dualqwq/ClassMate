import * as React from 'react';
import type { ChatMessage } from '../../../src/chat/types';
import { getIntentDisplay } from '../utils/intentConfig';
import { MarkdownRenderer } from './MarkdownRenderer';

interface MessageBubbleProps {
	message: ChatMessage;
	isStreaming: boolean;
	isCurrentStream: boolean;
}

function getDisplayContent(message: ChatMessage): string {
	if (
		message.role === 'user' &&
		message.isCommandGenerated &&
		message.intent === 'code_explanation'
	) {
		return 'Explain selected code';
	}
	return message.content;
}

export const MessageBubble: React.FC<MessageBubbleProps> = ({
	message,
	isCurrentStream,
}) => {
	const isUser = message.role === 'user';
	const intentDisplay = !isUser && message.intent ? getIntentDisplay(message.intent) : null;

	return (
		<div
			style={{
				display: 'flex',
				justifyContent: isUser ? 'flex-end' : 'flex-start',
				marginBottom: '12px',
			}}
		>
			<div
				style={{
					maxWidth: '85%',
					padding: '10px',
					paddingLeft: intentDisplay ? '11px' : '14px',
					borderRadius: '12px',
					background: isUser
						? 'var(--vscode-button-background)'
						: 'var(--vscode-editor-inactiveSelectionBackground)',
					color: isUser
						? 'var(--vscode-button-foreground)'
						: 'var(--vscode-foreground)',
					borderLeft: intentDisplay
						? `3px solid ${intentDisplay.accentColor}`
						: 'none',
					whiteSpace: isUser ? 'pre-wrap' : 'normal',
					wordBreak: 'break-word',
					lineHeight: '1.5',
				}}
			>
				{intentDisplay && (
					<div
						style={{
							display: 'flex',
							alignItems: 'center',
							gap: '6px',
							marginBottom: '6px',
							fontSize: '11px',
							fontWeight: 600,
							color: intentDisplay.accentColor,
							textTransform: 'uppercase',
							letterSpacing: '0.5px',
						}}
					>
						<span>{intentDisplay.icon}</span>
						<span>{intentDisplay.label}</span>
					</div>
				)}
				{isUser ? getDisplayContent(message) : <MarkdownRenderer content={message.content} />}
				{message.role === 'assistant' && isCurrentStream && (
					<span style={{ opacity: 0.6, marginLeft: '2px' }}>▋</span>
				)}
			</div>
		</div>
	);
};
