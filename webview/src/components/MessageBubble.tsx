import * as React from 'react';
import type { ChatMessage } from '../../../src/chat/types';

interface MessageBubbleProps {
	message: ChatMessage;
	isStreaming: boolean;
	isCurrentStream: boolean;
}

export const MessageBubble: React.FC<MessageBubbleProps> = ({
	message,
	isCurrentStream,
}) => {
	const isUser = message.role === 'user';

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
					padding: '10px 14px',
					borderRadius: '12px',
					background: isUser
						? 'var(--vscode-button-background)'
						: 'var(--vscode-editor-inactiveSelectionBackground)',
					color: isUser
						? 'var(--vscode-button-foreground)'
						: 'var(--vscode-foreground)',
					whiteSpace: 'pre-wrap',
					wordBreak: 'break-word',
					lineHeight: '1.5',
				}}
			>
				{message.content}
				{message.role === 'assistant' && isCurrentStream && (
					<span style={{ opacity: 0.6, marginLeft: '2px' }}>▋</span>
				)}
			</div>
		</div>
	);
};
