import * as React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatState, ExtensionToWebviewMessage, LLMConfig, MessageIntent } from '../../src/chat/types';
import { getInitialState, getContainer, sendMessage, subscribeToExtension } from './vscodeApi';
import { MessageBubble } from './components/MessageBubble';
import { SettingsPanel } from './components/SettingsPanel';

export const App: React.FC = () => {
	const [state, setState] = useState<ChatState>(getInitialState);
	const [input, setInput] = useState(state.inputDraft);
	const [container, setContainer] = useState<'view' | 'panel'>(getContainer);
	const [llmConfig, setLlmConfig] = useState<LLMConfig | null>(null);
	const [showSettings, setShowSettings] = useState(false);
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
			if (input.trim()) {
				sendMessage({ type: 'sendMessage', text: input, intent });
				setInput('');
				shouldScrollToBottomRef.current = true;
			}
		},
		[input]
	);

	const handleToggleContainer = useCallback(() => {
		sendMessage({ type: 'requestContainerToggle' });
	}, []);

	return (
		<div
			style={{
				display: 'flex',
				flexDirection: 'column',
				height: '100%',
				fontFamily: 'var(--vscode-font-family), sans-serif',
				background: 'var(--vscode-editor-background)',
				color: 'var(--vscode-foreground)',
			}}
		>
			<div
				ref={scrollRef}
				onScroll={handleScroll}
				style={{
					flex: 1,
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
					{state.isStreaming && (
						<span style={{ color: 'var(--vscode-descriptionForeground)', fontSize: '12px' }}>
							Thinking…
						</span>
					)}
				</div>
				<div
					style={{
						display: 'flex',
						flexWrap: 'wrap',
						gap: '8px',
						alignItems: 'stretch',
					}}
				>
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
						disabled={state.isStreaming || !input.trim()}
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
