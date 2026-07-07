import * as React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatState, ExtensionToWebviewMessage, MessageIntent } from '../../src/chat/types';
import { getInitialState, getContainer, sendMessage, subscribeToExtension } from './vscodeApi';

export const App: React.FC = () => {
	const [state, setState] = useState<ChatState>(getInitialState);
	const [input, setInput] = useState(state.inputDraft);
	const [container, setContainer] = useState<'view' | 'panel'>(getContainer);
	const scrollRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		return subscribeToExtension((message: ExtensionToWebviewMessage) => {
			switch (message.type) {
				case 'stateSync':
					setState(message.state);
					setInput(message.state.inputDraft);
					break;
				case 'streamStart':
				case 'streamEnd':
				case 'appendToken':
					// State deltas are merged into the next stateSync; ignore here
					// because ChatSession already broadcasts a full stateSync after
					// streaming ends. Keeping this handler allows future optimistic
					// append without stateSync if needed.
					break;
				case 'containerInfo':
					setContainer(message.container);
					break;
			}
		});
	}, []);

	useEffect(() => {
		if (scrollRef.current) {
			scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
		}
	}, [state.messages, state.isStreaming]);

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
			}
		},
		[input]
	);

	const handleToggleContainer = useCallback(() => {
		sendMessage({ type: 'requestContainerToggle' });
	}, []);

	return (
		<div style={{ display: 'flex', flexDirection: 'column', height: '100vh', fontFamily: 'sans-serif' }}>
			<div
				ref={scrollRef}
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
					<div
						key={msg.id}
						style={{
							display: 'flex',
							justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start',
							marginBottom: '12px',
						}}
					>
						<div
							style={{
								maxWidth: '80%',
								padding: '10px 14px',
								borderRadius: '12px',
								background:
									msg.role === 'user'
										? 'var(--vscode-button-background)'
										: 'var(--vscode-editor-inactiveSelectionBackground)',
								color:
									msg.role === 'user'
										? 'var(--vscode-button-foreground)'
										: 'var(--vscode-foreground)',
								whiteSpace: 'pre-wrap',
								wordBreak: 'break-word',
							}}
						>
							{msg.content}
							{msg.role === 'assistant' && msg.id === state.currentStreamMessageId && (
								<span style={{ opacity: 0.6 }}>▋</span>
							)}
						</div>
					</div>
				))}
			</div>

			<div style={{ padding: '12px', borderTop: '1px solid var(--vscode-panel-border)' }}>
				<div
					style={{
						display: 'flex',
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
						}}
					>
						{container === 'view' ? '⛶' : '☰'}
					</button>
					<span style={{ flex: 1 }} />
					{state.isStreaming && (
						<span style={{ color: 'var(--vscode-descriptionForeground)', fontSize: '12px' }}>
							Thinking…
						</span>
					)}
				</div>
				<div style={{ display: 'flex', gap: '8px' }}>
					<input
						type="text"
						value={input}
						onChange={(e) => handleInputChange(e.target.value)}
						onKeyDown={(e) => e.key === 'Enter' && handleSend()}
						placeholder="Ask ClassMate..."
						disabled={state.isStreaming}
						style={{
							flex: 1,
							padding: '8px 12px',
							borderRadius: '6px',
							border: '1px solid var(--vscode-input-border)',
							background: 'var(--vscode-input-background)',
							color: 'var(--vscode-input-foreground)',
						}}
					/>
					<button
						onClick={() => handleSend()}
						disabled={state.isStreaming || !input.trim()}
						style={{
							padding: '8px 16px',
							borderRadius: '6px',
							border: 'none',
							background: 'var(--vscode-button-background)',
							color: 'var(--vscode-button-foreground)',
							cursor: 'pointer',
						}}
					>
						Send
					</button>
				</div>
			</div>
		</div>
	);
};
