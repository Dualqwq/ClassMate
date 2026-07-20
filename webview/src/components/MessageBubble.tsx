import * as React from 'react';
import type { ChatMessage } from '../../../src/chat/types';
import { getIntentDisplay } from '../utils/intentConfig';
import { MarkdownRenderer } from './MarkdownRenderer';
import { sendMessage } from '../vscodeApi';

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
	const isSystemPromptDebug = message.role === 'system' && message.isSystemPromptDebug;
	const isDebugLog = message.role === 'system' && message.isDebugLog;
	const isDebugJourney = message.role === 'system' && message.isDebugJourney;
	const intentDisplay = !isUser && !isSystemPromptDebug && !isDebugLog && !isDebugJourney && message.intent ? getIntentDisplay(message.intent) : null;

	if (isSystemPromptDebug) {
		return (
			<div style={{ marginBottom: '12px' }}>
				<div
					style={{
						fontSize: '10px',
						fontWeight: 600,
						textTransform: 'uppercase',
						letterSpacing: '0.5px',
						color: 'var(--vscode-debugIcon-startForeground)',
						marginBottom: '4px',
						marginLeft: '2px',
					}}
				>
					System prompt (debug)
				</div>
				<div
					style={{
						maxWidth: '100%',
						padding: '10px 14px',
						borderRadius: '12px',
						background: 'var(--vscode-textCodeBlock-background)',
						color: 'var(--vscode-foreground)',
						border: '1px dashed var(--vscode-panel-border)',
						fontFamily: 'var(--vscode-editor-font-family), monospace',
						fontSize: '11px',
						whiteSpace: 'pre-wrap',
						wordBreak: 'break-word',
						lineHeight: '1.4',
						maxHeight: '400px',
						overflowY: 'auto',
					}}
				>
					{message.content}
				</div>
			</div>
		);
	}

	if (isDebugJourney) {
		return (
			<div style={{ marginBottom: '12px' }}>
				<div
					style={{
						fontSize: '10px',
						fontWeight: 600,
						textTransform: 'uppercase',
						letterSpacing: '0.5px',
						color: 'var(--vscode-debugIcon-startForeground)',
						marginBottom: '4px',
						marginLeft: '2px',
					}}
				>
					Debug Journey (debug)
				</div>
				<div
					style={{
						maxWidth: '100%',
						padding: '10px 14px',
						borderRadius: '12px',
						background: 'var(--vscode-textCodeBlock-background)',
						color: 'var(--vscode-foreground)',
						border: '1px dashed var(--vscode-panel-border)',
						fontFamily: 'var(--vscode-editor-font-family), monospace',
						fontSize: '11px',
						whiteSpace: 'pre-wrap',
						wordBreak: 'break-word',
						lineHeight: '1.4',
						maxHeight: '400px',
						overflowY: 'auto',
					}}
				>
					{message.content}
				</div>
			</div>
		);
	}

	if (isDebugLog) {
		return (
			<div style={{ marginBottom: '12px' }}>
				<div
					style={{
						fontSize: '10px',
						fontWeight: 600,
						textTransform: 'uppercase',
						letterSpacing: '0.5px',
						color: 'var(--vscode-debugIcon-startForeground)',
						marginBottom: '4px',
						marginLeft: '2px',
					}}
				>
					Implicit log (debug)
				</div>
				<div
					style={{
						maxWidth: '100%',
						padding: '10px 14px',
						borderRadius: '12px',
						background: 'var(--vscode-textCodeBlock-background)',
						color: 'var(--vscode-foreground)',
						border: '1px dashed var(--vscode-panel-border)',
						fontFamily: 'var(--vscode-editor-font-family), monospace',
						fontSize: '11px',
						whiteSpace: 'pre-wrap',
						wordBreak: 'break-word',
						lineHeight: '1.4',
						maxHeight: '400px',
						overflowY: 'auto',
					}}
				>
					{message.content}
				</div>
			</div>
		);
	}

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
						? `3px solid var(--vscode-button-foreground)`
						: 'none',
					whiteSpace: isUser ? 'pre-wrap' : 'normal',
					wordBreak: 'break-word',
					lineHeight: '1.5',
				}}
			>
				{message.images && message.images.length > 0 && (
					<div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '8px' }}>
						{message.images.map((image, index) => (
							<img
								key={`${image.name}-${index}`}
								src={image.dataUrl}
								alt={image.name}
								style={{ maxWidth: '180px', maxHeight: '140px', objectFit: 'contain', borderRadius: '6px' }}
							/>
						))}
					</div>
				)}
				{message.attachments && message.attachments.length > 0 && (
					<div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px', marginBottom: '8px' }}>
						{message.attachments.map((attachment, index) => (
							<span
								key={`${attachment.name}-${index}`}
								style={{ border: '1px solid var(--vscode-panel-border)', borderRadius: '5px', padding: '3px 6px', fontSize: '10px' }}
							>
								📎 {attachment.name}
							</span>
						))}
					</div>
				)}
				{message.references && message.references.length > 0 && (
					<div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px', marginBottom: '7px' }}>
						{message.references.map((reference, index) => (
							<button
								key={`${reference.uri}-${index}`}
								onClick={() => sendMessage({ type: 'openReference', reference })}
								title={reference.uri}
								style={{
									border: '1px solid var(--vscode-panel-border)',
									borderRadius: '5px',
									background: 'transparent',
									color: 'inherit',
									cursor: 'pointer',
									fontSize: '10px',
									padding: '2px 6px',
								}}
							>
								⌘ {reference.label}
								{reference.startLine ? `:${reference.startLine}` : ''}
							</button>
						))}
					</div>
				)}
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
				{message.role === 'assistant' && message.usage && !isCurrentStream && (
					<div
						style={{
							marginTop: '8px',
							fontSize: '10px',
							color: 'var(--vscode-descriptionForeground)',
						}}
					>
						Input {message.usage.inputTokens} · Output {message.usage.outputTokens}
						{message.usage.cacheHitTokens !== undefined &&
							` · Cache hit ${message.usage.cacheHitTokens}`}
						{message.usage.cacheMissTokens !== undefined &&
							` · Cache miss ${message.usage.cacheMissTokens}`}
					</div>
				)}
				{message.role === 'assistant' && message.proposedEdit && !isCurrentStream && (
					<button
						onClick={() => sendMessage({ type: 'applyProposedEdit', messageId: message.id })}
						style={{
							marginTop: '10px',
							padding: '6px 10px',
							border: 'none',
							borderRadius: '5px',
							background: 'var(--vscode-button-background)',
							color: 'var(--vscode-button-foreground)',
							cursor: 'pointer',
						}}
					>
						Apply to {message.proposedEdit.fileName}
					</button>
				)}
			</div>
		</div>
	);
};
