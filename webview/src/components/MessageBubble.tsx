import * as React from 'react';
import type { ChatMessage } from '../../../src/chat/types';
import { getIntentDisplay } from '../utils/intentConfig';
import { MarkdownRenderer } from './MarkdownRenderer';
import { sendMessage } from '../vscodeApi';

interface MessageBubbleProps {
	message: ChatMessage;
	isStreaming: boolean;
	isCurrentStream: boolean;
	processingStage?: string | null;
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
	processingStage,
}) => {
	const [copied, setCopied] = React.useState(false);
	const isUser = message.role === 'user';
	const showProcessingStage = !isUser
		&& isCurrentStream
		&& message.content.length === 0
		&& Boolean(processingStage);
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
					<div style={{ marginBottom: '8px' }}>
						<div className="message-meta-label">相关位置</div>
						<div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px' }}>
							{message.references.map((reference, index) => (
								<button
									key={`${reference.uri}-${index}`}
									onClick={() => sendMessage({ type: 'openReference', reference })}
									title={reference.uri}
									className="reference-chip"
								>
									↗ {reference.label}
									{reference.startLine ? `:${reference.startLine}` : ''}
								</button>
							))}
						</div>
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
				{isUser
					? getDisplayContent(message)
					: showProcessingStage
						? (
							<div className="processing-stage" role="status" aria-live="polite">
								<span className="processing-spinner" aria-hidden="true" />
								<span>{processingStage}</span>
							</div>
						)
						: <MarkdownRenderer content={message.content} />}
				{message.role === 'assistant' && isCurrentStream && (
					<span style={{ opacity: 0.6, marginLeft: '2px' }}>▋</span>
				)}
				{message.role === 'assistant' && message.usage && !isCurrentStream && (
					<details className="message-details">
						<summary>
							Token：{message.usage.totalTokens
								?? message.usage.inputTokens + message.usage.outputTokens}
						</summary>
						<div>输入 {message.usage.inputTokens} · 输出 {message.usage.outputTokens}</div>
						{message.usage.cacheHitTokens !== undefined && (
							<div>缓存命中 {message.usage.cacheHitTokens}</div>
						)}
						{message.usage.cacheMissTokens !== undefined && (
							<div>缓存未命中 {message.usage.cacheMissTokens}</div>
						)}
					</details>
				)}
				{message.role === 'assistant'
					&& message.contextSummary
					&& !isCurrentStream && (
					<details className="message-details">
						<summary>
							本轮读取了 {message.contextSummary.workspaceFiles.length} 个工作区文件
						</summary>
						{message.contextSummary.workspaceFiles.length > 0 ? (
							<ul className="context-file-list">
								{message.contextSummary.workspaceFiles.map((file) => (
									<li key={file} title={file}>{file}</li>
								))}
							</ul>
						) : (
							<div>本轮没有读取工作区文件。</div>
						)}
					</details>
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
						应用到 {message.proposedEdit.fileName}
					</button>
				)}
				{message.role === 'assistant' && !isCurrentStream && message.content && (
					<div className="message-actions">
						<button
							onClick={() => {
								void navigator.clipboard.writeText(message.content).then(() => {
									setCopied(true);
									window.setTimeout(() => setCopied(false), 1500);
								});
							}}
							className="message-action-button"
							title="复制回答"
						>
							{copied ? '已复制' : '复制'}
						</button>
					</div>
				)}
			</div>
		</div>
	);
};
