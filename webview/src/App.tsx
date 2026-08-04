import * as React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatAttachment, ChatImage, ChatState, ExtensionToWebviewMessage, LLMConfig, MessageIntent } from '../../src/chat/types';
import { getInitialState, getContainer, sendMessage, subscribeToExtension } from './vscodeApi';
import { MessageBubble } from './components/MessageBubble';
import { SettingsPanel } from './components/SettingsPanel';
import './classmate.css';

const QUICK_PROMPTS: Array<{
	title: string;
	description: string;
	text: string;
}> = [
	{
		title: '这题我没思路',
		description: '结合当前题目给我第一步提示',
		text: '这题我没思路，能先告诉我应该从哪里开始想吗？',
	},
	{
		title: '帮我看看代码',
		description: '定位当前代码里最可能的问题',
		text: '帮我看看当前代码哪里可能有问题，先说最需要检查的一处。',
	},
	{
		title: '为什么会报错',
		description: '分析瓶颈和时间复杂度',
		text: '我的代码为什么会超时？请结合当前代码分析时间复杂度。',
	},
	{
		title: '解释一个概念',
		description: '用初学者能听懂的话说明',
		text: '我有一个概念不太懂：',
	},
];

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
	const [showJumpToLatest, setShowJumpToLatest] = useState(false);
	const scrollRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const shouldScrollToBottomRef = useRef(true);
	// Composer race protection (see 0803后要干的事情.md #10):
	// isComposing — 用 useState,因为 textarea 的 value 依赖它做"非受控 / 受控"切换。
	// composerDirtyRef — 本地已被用户改动,不要被 stateSync.inputDraft 覆盖(同会话内)。
	// activeConversationIdRef — 切换会话的 stateSync 允许覆盖(新会话的草稿是权威的)。
	// inputDraftFlushTimerRef — 防抖:快速打字时合并 inputDraftChanged,只在停下来时才发 IPC。
	const [isComposing, setIsComposing] = useState(false);
	const composerDirtyRef = useRef(false);
	const activeConversationIdRef = useRef<string>(getInitialState().activeConversationId);
	const inputDraftFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const INPUT_DRAFT_FLUSH_MS = 80;

	useEffect(() => {
		// Request LLM config on mount.
		sendMessage({ type: 'requestLLMConfig' });

		return subscribeToExtension((message: ExtensionToWebviewMessage) => {
			switch (message.type) {
				case 'stateSync':
					setState(message.state);
					// 切到了别的会话 → 新的 inputDraft 是权威值,允许覆盖。
					const switchedConversation = message.state.activeConversationId !== activeConversationIdRef.current;
					if (switchedConversation) {
						activeConversationIdRef.current = message.state.activeConversationId;
						composerDirtyRef.current = false;
						setInput(message.state.inputDraft ?? '');
						break;
					}
					// 同会话内:本地 dirty 时不动 input(等用户 blur 或切换会话再对齐)。
					// 流期间"瘦身 stateSync"不带 inputDraft,这里也会自然跳过 setInput。
					if (composerDirtyRef.current) {
						break;
					}
					if (typeof message.state.inputDraft === 'string') {
						setInput(message.state.inputDraft);
					}
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

	// 组件卸载时清掉待发的 inputDraft timer,避免 unmount 后还在 setState。
	useEffect(() => {
		return () => {
			if (inputDraftFlushTimerRef.current !== null) {
				clearTimeout(inputDraftFlushTimerRef.current);
				inputDraftFlushTimerRef.current = null;
			}
		};
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

	useEffect(() => {
		const el = inputRef.current;
		if (!el) {
			return;
		}
		el.style.height = 'auto';
		el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
	}, [input]);

	const handleScroll = useCallback(() => {
		const el = scrollRef.current;
		if (!el) {
			return;
		}
		const nearBottomThreshold = 32;
		const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
		shouldScrollToBottomRef.current = distanceFromBottom <= nearBottomThreshold;
		setShowJumpToLatest(distanceFromBottom > 160);
	}, []);

	const flushInputDraft = useCallback((text: string) => {
		sendMessage({ type: 'inputDraftChanged', text });
	}, []);

	const handleInputChange = useCallback(
		(text: string) => {
			// 本地立即渲染:这是用户看到的字符"出来"的真正路径。
			// 不要等后端 echo —— 之前的实现每个按键都走 webview → extension → webview 一圈,
			// IPC 抖动 1-5ms,快速打字时字符出现明显落后于手速。
			setInput(text);
			composerDirtyRef.current = true;
			// 后端同步去抖:把"最后一次输入值"在 80ms 内合并,只在用户停下来时打一次 IPC。
			// 80ms 内一定有用户继续打字就重置 timer。
			if (inputDraftFlushTimerRef.current !== null) {
				clearTimeout(inputDraftFlushTimerRef.current);
			}
			inputDraftFlushTimerRef.current = setTimeout(() => {
				inputDraftFlushTimerRef.current = null;
				flushInputDraft(text);
			}, INPUT_DRAFT_FLUSH_MS);
		},
		[flushInputDraft]
	);

	const flushDraftBeforeNavigation = useCallback(() => {
		// 切换/新建对话前,把当前 input 同步给后端,避免出现"切走后再切回来,旧草稿丢了"。
		if (inputDraftFlushTimerRef.current !== null) {
			clearTimeout(inputDraftFlushTimerRef.current);
			inputDraftFlushTimerRef.current = null;
		}
		if (composerDirtyRef.current) {
			sendMessage({ type: 'inputDraftChanged', text: input });
			composerDirtyRef.current = false;
		}
	}, [input]);

	const handleSend = useCallback(
		(intent?: MessageIntent) => {
			if (input.trim() || pendingImages.length > 0 || pendingAttachments.length > 0) {
				if (inputDraftFlushTimerRef.current !== null) {
					clearTimeout(inputDraftFlushTimerRef.current);
					inputDraftFlushTimerRef.current = null;
				}
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
				composerDirtyRef.current = false;
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

	const chooseQuickPrompt = useCallback((text: string) => {
		handleInputChange(text);
		requestAnimationFrame(() => {
			inputRef.current?.focus();
			inputRef.current?.setSelectionRange(text.length, text.length);
		});
	}, [handleInputChange]);

	const jumpToLatest = useCallback(() => {
		const el = scrollRef.current;
		if (!el) {
			return;
		}
		shouldScrollToBottomRef.current = true;
		setShowJumpToLatest(false);
		el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
	}, []);

	return (
		<div className="classmate-app">
			<header className="classmate-header">
				<div className="classmate-header-row">
					<div className="classmate-brand">
						<div className="classmate-mark" aria-hidden="true">C</div>
						<div className="classmate-brand-copy">
							<div className="classmate-title">ClassMate</div>
							<div className="classmate-subtitle">结合当前题目和代码回答</div>
						</div>
					</div>
					<span className="classmate-spacer" />
					<button
						onClick={() => setShowHistory((value) => !value)}
						className="icon-button"
						title="查看历史会话"
						aria-expanded={showHistory}
					>
						历史 {showHistory ? '⌃' : '⌄'}
					</button>
					<button
						onClick={() => {
							flushDraftBeforeNavigation();
							sendMessage({ type: 'newConversation' });
						}}
						title="新建对话"
						className="icon-button"
						disabled={state.isStreaming}
					>
						＋
					</button>
				</div>
				{showHistory && (
					<div className="history-panel">
						{state.conversations.map((conversation) => (
							<button
								key={conversation.id}
								onClick={() => {
									if (conversation.id === state.activeConversationId) {
										return;
									}
									flushDraftBeforeNavigation();
									sendMessage({ type: 'switchConversation', conversationId: conversation.id });
								}}
								className={`history-item ${
									conversation.id === state.activeConversationId ? 'active' : ''
								}`}
							>
								<div className="history-title">{conversation.title}</div>
								<div className="history-date">
									{formatConversationDate(conversation.updatedAt)}
								</div>
							</button>
						))}
					</div>
				)}
			</header>
			<div
				ref={scrollRef}
				onScroll={handleScroll}
				className="classmate-messages"
			>
				{state.messages.length === 0 && (
					<div className="welcome-card">
						<h1>现在卡在哪里？</h1>
						<p>
							直接用平时提问的方式说就可以。ClassMate 会优先查看当前题目和代码，
							再给出适合初学者的下一步。
						</p>
						<div className="quick-prompts">
							{QUICK_PROMPTS.map((prompt) => (
								<button
									key={prompt.title}
									className="quick-prompt"
									onClick={() => chooseQuickPrompt(prompt.text)}
								>
									<strong>{prompt.title}</strong>
									<span>{prompt.description}</span>
								</button>
							))}
						</div>
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
				{showJumpToLatest && (
					<button className="jump-latest" onClick={jumpToLatest}>
						回到最新 ↓
					</button>
				)}
			</div>

			<div className="classmate-composer">
				{pendingImages.length > 0 && (
					<div className="pending-items">
						{pendingImages.map((image, index) => (
							<div key={`${image.name}-${index}`} className="pending-image">
								<img src={image.dataUrl} alt={image.name} />
								<button
									onClick={() => setPendingImages((current) => current.filter((_, itemIndex) => itemIndex !== index))}
									className="remove-image"
									title={`移除 ${image.name}`}
								>×</button>
							</div>
						))}
					</div>
				)}
				{pendingAttachments.length > 0 && (
					<div className="pending-items">
						{pendingAttachments.map((attachment, index) => (
							<button
								key={`${attachment.name}-${index}`}
								onClick={() => setPendingAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index))}
								title="点击移除"
								className="attachment-chip"
							>
								📎 {attachment.name} ×
							</button>
						))}
					</div>
				)}
				<div className="classmate-toolbar">
					<button
						onClick={handleToggleContainer}
						title={container === 'view' ? '在编辑器区域中打开' : '移回侧边栏'}
						className="icon-button"
					>
						{container === 'view' ? '⛶' : '☰'}
					</button>
					<button
						onClick={() => setShowSettings(true)}
						title="模型设置"
						className="icon-button"
					>
						⚙
					</button>
					{llmConfig && (
						<span className="model-label">
							{llmConfig.provider} · {llmConfig.model}
						</span>
					)}
					<span className="classmate-spacer" />
				</div>
				<div className="composer-shell">
					<label
						title="上传图片或附件（单文件最大10MB）"
						className="attach-label"
					>
						📎
						<input
							type="file"
							multiple
							onChange={(event) => { handleFiles(event.target.files); event.target.value = ''; }}
							style={{ display: 'none' }}
						/>
					</label>
					<textarea
						ref={inputRef}
						rows={1}
						// 关键:composition 期间 value=undefined(非受控),让浏览器原生管理 IME;
						// composition 结束才切回受控,React 不再打断 IME 合成。
						value={isComposing ? undefined : input}
						onCompositionStart={() => { setIsComposing(true); }}
						onCompositionEnd={(event) => {
							setIsComposing(false);
							// 合成结束时 DOM value 已稳定,主动写一次,让后端草稿追上 DOM。
							const text = (event.target as HTMLTextAreaElement).value;
							handleInputChange(text);
						}}
						onBlur={() => {
							setIsComposing(false);
							composerDirtyRef.current = false;
						}}
						onChange={(e) => {
							// onChange 在 compositionend 之后的 input 事件触发,此时 React 已切回受控。
							handleInputChange(e.target.value);
						}}
						onKeyDown={(event) => {
							if (event.key === 'Enter' && !event.shiftKey && !isComposing) {
								event.preventDefault();
								handleSend();
							}
						}}
						placeholder="直接说你卡在哪里…"
						disabled={state.isStreaming}
						className="composer-input"
					/>
					{state.isStreaming ? (
						<button
							onClick={() => sendMessage({ type: 'cancelResponse' })}
							className="stop-button"
							title="停止当前回答"
						>
							停止
						</button>
					) : (
						<button
							onClick={() => handleSend()}
							disabled={!input.trim() && pendingImages.length === 0 && pendingAttachments.length === 0}
							className="primary-button"
						>
							发送
						</button>
					)}
				</div>
				<div className="composer-help">Enter 发送 · Shift+Enter 换行</div>
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
