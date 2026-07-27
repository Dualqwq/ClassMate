import * as React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatAttachment, ChatImage, ChatState, ExtensionToWebviewMessage, LLMConfig, MessageIntent } from '../../src/chat/types';
import { getInitialState, getContainer, sendMessage, subscribeToExtension } from './vscodeApi';
import { MessageBubble } from './components/MessageBubble';
import { SettingsPanel } from './components/SettingsPanel';

function formatConversationDate(timestamp: number): string {
	const elapsedDays = Math.floor((Date.now() - timestamp) / 86_400_000);
	if (elapsedDays <= 0) {
		return '今天';
	}
	if (elapsedDays === 1) {
		return '1 天前';
	}
	if (elapsedDays < 7) {
		return `${elapsedDays} 天前`;
	}
	return new Date(timestamp).toLocaleDateString('zh-CN');
}

export const App: React.FC = () => {
	const [state, setState] = useState<ChatState>(getInitialState);
	const [input, setInput] = useState(state.inputDraft);
	const [container, setContainer] = useState<'view' | 'panel'>(getContainer);
	const [llmConfig, setLlmConfig] = useState<LLMConfig | null>(null);
	const [showSettings, setShowSettings] = useState(false);
	const [showHistory, setShowHistory] = useState(false);
	const [pendingImages, setPendingImages] = useState<ChatImage[]>([]);
	const [pendingAttachments, setPendingAttachments] = useState<ChatAttachment[]>([]);
	const scrollRef = useRef<HTMLDivElement>(null);
	const shouldScrollToBottomRef = useRef(true);

	useEffect(() => {
		// Request LLM config on mount.
		sendMessage({ type: 'requestLLMConfig' });

		return subscribeToExtension((message: ExtensionToWebviewMessage) => {
			switch (message.type) {
				case 'stateSync':
					setState(message.state);
					setInput(message.state.inputDraft);
					break;
				case 'streamStart':
					setState((prev) => ({
						...prev,
						messages: [...prev.messages, message.message],
						isStreaming: true,
						currentStreamMessageId: message.message.id,
					}));
					break;
				case 'appendToken':
					setState((prev) => ({
						...prev,
						messages: prev.messages.map((m) =>
							m.id === message.messageId ? { ...m, content: m.content + message.token } : m
						),
					}));
					break;
				case 'streamEnd':
					setState((prev) => ({
						...prev,
						isStreaming: false,
						currentStreamMessageId: null,
					}));
					break;
				case 'containerInfo':
					setContainer(message.container);
					break;
				case 'llmConfig':
					setLlmConfig(message.config);
					break;
			}
		});
	}, []);

	// Auto-scroll to bottom when new messages arrive or streaming continues,
	// but only if the user is already near the bottom.
	useEffect(() => {
		const el = scrollRef.current;
		if (!el) {
			return;
		}
		if (shouldScrollToBottomRef.current) {
			el.scrollTop = el.scrollHeight;
		}
	}, [state.messages, state.isStreaming]);

	const handleScroll = useCallback(() => {
		const el = scrollRef.current;
		if (!el) {
			return;
		}
		const nearBottomThreshold = 32;
		const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
		shouldScrollToBottomRef.current = distanceFromBottom <= nearBottomThreshold;
	}, []);

	const handleInputChange = useCallback(
		(text: string) => {
			setInput(text);
			sendMessage({ type: 'inputDraftChanged', text });
		},
		[]
	);

	const handleSend = useCallback(
		(intent?: MessageIntent) => {
			if (input.trim() || pendingImages.length > 0 || pendingAttachments.length > 0) {
				sendMessage({
					type: 'sendMessage',
					text: input || '请分析这些附件。',
					intent,
					images: pendingImages,
					attachments: pendingAttachments,
				});
				setInput('');
				setPendingImages([]);
				setPendingAttachments([]);
				shouldScrollToBottomRef.current = true;
			}
		},
		[input, pendingImages, pendingAttachments]
	);

	const handleFiles = useCallback((files: FileList | null) => {
		if (!files) {
			return;
		}
		const readableExtensions = /\.(c|cc|cpp|cxx|h|hh|hpp|hxx|md|txt|mk|json|js|jsx|ts|tsx|py|java|css|html|xml|yaml|yml|toml|ini|csv)$/i;
		const isMakefileName = (fileName: string) => /^(?:gnu)?makefile$/i.test(fileName);
		for (const file of Array.from(files)) {
			if (file.size > 10 * 1024 * 1024) {
				continue;
			}
			if (!file.type.startsWith('image/')) {
				const attachment: ChatAttachment = {
					name: file.name,
					mimeType: file.type || 'application/octet-stream',
					size: file.size,
				};
				if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
					const pdfReader = new FileReader();
					pdfReader.onload = () => {
						setPendingAttachments((current) => [...current, {
							...attachment,
							mimeType: 'application/pdf',
							dataUrl: typeof pdfReader.result === 'string' ? pdfReader.result : undefined,
						}]);
					};
					pdfReader.readAsDataURL(file);
				} else if (
					file.type.startsWith('text/') ||
					readableExtensions.test(file.name) ||
					isMakefileName(file.name)
				) {
					const textReader = new FileReader();
					textReader.onload = () => {
						setPendingAttachments((current) => [...current, {
							...attachment,
							content: typeof textReader.result === 'string' ? textReader.result : '',
						}]);
					};
					textReader.readAsText(file);
				} else {
					setPendingAttachments((current) => [...current, attachment]);
				}
				continue;
			}
			const reader = new FileReader();
			reader.onload = () => {
				if (typeof reader.result === 'string') {
					setPendingImages((current) => [...current, {
						name: file.name,
						mimeType: file.type,
						dataUrl: reader.result as string,
					}]);
				}
			};
			reader.readAsDataURL(file);
		}
	}, []);

	const handleToggleContainer = useCallback(() => {
		sendMessage({ type: 'requestContainerToggle' });
	}, []);

	return (
		<div
			style={{
				display: 'flex',
				flexDirection: 'column',
				// Use the webview viewport directly. A percentage height can grow with
				// long message content in some VS Code panel layouts, pushing the input
				// controls below the visible area.
				height: '100vh',
				maxHeight: '100vh',
				minHeight: 0,
				overflow: 'hidden',
				fontFamily: 'var(--vscode-font-family), sans-serif',
				background: 'var(--vscode-editor-background)',
				color: 'var(--vscode-foreground)',
			}}
		>
			<div
				style={{
					padding: '8px 12px',
					borderBottom: '1px solid var(--vscode-panel-border)',
					background: 'var(--vscode-sideBar-background)',
				}}
			>
				<div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
					<button
						onClick={() => setShowHistory((value) => !value)}
						style={{ border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer', fontWeight: 600 }}
					>
						会话 {showHistory ? '⌃' : '⌄'}
					</button>
					<span style={{ flex: 1 }} />
					<button
						onClick={() => sendMessage({ type: 'newConversation' })}
						title="新建对话"
						style={{ border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: '18px' }}
					>
						＋
					</button>
				</div>
				{showHistory && (
					<div style={{ marginTop: '6px', maxHeight: '180px', overflowY: 'auto' }}>
						{state.conversations.map((conversation) => (
							<button
								key={conversation.id}
								onClick={() => sendMessage({ type: 'switchConversation', conversationId: conversation.id })}
								style={{
									display: 'block',
									width: '100%',
									padding: '7px 8px',
									textAlign: 'left',
									border: 'none',
									borderRadius: '6px',
									background: conversation.id === state.activeConversationId
										? 'var(--vscode-list-activeSelectionBackground)'
										: 'transparent',
									color: 'inherit',
									cursor: 'pointer',
								}}
							>
								<div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
									{conversation.title}
								</div>
								<div style={{ fontSize: '10px', color: 'var(--vscode-descriptionForeground)', marginTop: '2px' }}>
									{formatConversationDate(conversation.updatedAt)}
								</div>
							</button>
						))}
					</div>
				)}
			</div>
			<div
				ref={scrollRef}
				onScroll={handleScroll}
				style={{
					flex: 1,
					minHeight: 0,
					overflowY: 'auto',
					padding: '16px',
					borderBottom: '1px solid var(--vscode-panel-border)',
				}}
			>
				{state.messages.length === 0 && (
					<div style={{ color: 'var(--vscode-descriptionForeground)' }}>
						Ask ClassMate anything about your C++ code.
					</div>
				)}
				{state.messages.map((msg) => (
					<MessageBubble
						key={msg.id}
						message={msg}
						isStreaming={state.isStreaming}
						isCurrentStream={msg.id === state.currentStreamMessageId}
						processingStage={
							msg.id === state.currentStreamMessageId
								? state.processingStage
								: null
						}
					/>
				))}
			</div>

			<div
				style={{
					padding: '12px',
					borderTop: '1px solid var(--vscode-panel-border)',
					background: 'var(--vscode-sideBar-background)',
					flexShrink: 0,
				}}
			>
				{pendingImages.length > 0 && (
					<div style={{ display: 'flex', gap: '6px', marginBottom: '8px', flexWrap: 'wrap' }}>
						{pendingImages.map((image, index) => (
							<div key={`${image.name}-${index}`} style={{ position: 'relative' }}>
								<img src={image.dataUrl} alt={image.name} style={{ width: '52px', height: '52px', objectFit: 'cover', borderRadius: '6px' }} />
								<button
									onClick={() => setPendingImages((current) => current.filter((_, itemIndex) => itemIndex !== index))}
									style={{ position: 'absolute', right: '-5px', top: '-5px', borderRadius: '50%', border: 'none', cursor: 'pointer' }}
								>×</button>
							</div>
						))}
					</div>
				)}
				{pendingAttachments.length > 0 && (
					<div style={{ display: 'flex', gap: '6px', marginBottom: '8px', flexWrap: 'wrap' }}>
						{pendingAttachments.map((attachment, index) => (
							<button
								key={`${attachment.name}-${index}`}
								onClick={() => setPendingAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index))}
								title="点击移除"
								style={{ border: '1px solid var(--vscode-panel-border)', borderRadius: '6px', padding: '5px 8px', background: 'transparent', color: 'inherit', cursor: 'pointer' }}
							>
								📎 {attachment.name} ×
							</button>
						))}
					</div>
				)}
				<div
					style={{
						display: 'flex',
						flexWrap: 'wrap',
						alignItems: 'center',
						gap: '8px',
						marginBottom: '8px',
					}}
				>
					<button
						onClick={handleToggleContainer}
						title={container === 'view' ? 'Open in Panel' : 'Move to Sidebar'}
						style={{
							background: 'transparent',
							border: 'none',
							color: 'var(--vscode-foreground)',
							cursor: 'pointer',
							fontSize: '13px',
							padding: '4px',
						}}
					>
						{container === 'view' ? '⛶' : '☰'}
					</button>
					<button
						onClick={() => setShowSettings(true)}
						title="LLM Settings"
						style={{
							background: 'transparent',
							border: 'none',
							color: 'var(--vscode-foreground)',
							cursor: 'pointer',
							fontSize: '13px',
							padding: '4px',
						}}
					>
						⚙
					</button>
					{llmConfig && (
						<span
							style={{
								color: 'var(--vscode-descriptionForeground)',
								fontSize: '11px',
								flex: 1,
							}}
						>
							{llmConfig.provider} · {llmConfig.model}
						</span>
					)}
					<span style={{ flex: 1 }} />
				</div>
				<div
					style={{
						display: 'flex',
						flexWrap: 'wrap',
						gap: '8px',
						alignItems: 'stretch',
					}}
				>
					<label
						title="上传图片或附件（单文件最大10MB）"
						style={{ padding: '8px', cursor: 'pointer', fontSize: '18px' }}
					>
						＋
						<input
							type="file"
							multiple
							onChange={(event) => { handleFiles(event.target.files); event.target.value = ''; }}
							style={{ display: 'none' }}
						/>
					</label>
					<input
						type="text"
						value={input}
						onChange={(e) => handleInputChange(e.target.value)}
						onKeyDown={(e) => e.key === 'Enter' && handleSend()}
						placeholder="Ask ClassMate..."
						disabled={state.isStreaming}
						style={{
							flex: '1 1 0',
							minWidth: '80px',
							padding: '8px 12px',
							borderRadius: '6px',
							border: '1px solid var(--vscode-input-border)',
							background: 'var(--vscode-input-background)',
							color: 'var(--vscode-input-foreground)',
							boxSizing: 'border-box',
						}}
					/>
					<button
						onClick={() => handleSend()}
						disabled={state.isStreaming || (!input.trim() && pendingImages.length === 0 && pendingAttachments.length === 0)}
						style={{
							padding: '8px 12px',
							borderRadius: '6px',
							border: 'none',
							background: 'var(--vscode-button-background)',
							color: 'var(--vscode-button-foreground)',
							cursor: 'pointer',
							whiteSpace: 'nowrap',
							minWidth: '48px',
							boxSizing: 'border-box',
						}}
					>
						Send
					</button>
				</div>
			</div>

			{showSettings && (
				<SettingsPanel
					key={`settings-${Date.now()}`}
					config={llmConfig}
					onClose={() => setShowSettings(false)}
				/>
			)}
		</div>
	);
};
