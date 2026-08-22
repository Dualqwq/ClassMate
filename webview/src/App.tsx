import * as React from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ChatAttachment, ChatImage, ChatState, LLMConfig, MessageIntent } from '../../src/chat/types';
import { applyClassMateTheme } from '../../src/chat/classmateTheme';
import { getInitialState, getContainer, getRoute, sendMessage, subscribeToExtension, type AnyExtensionToWebviewMessage } from './vscodeApi';
import { MessageBubble } from './components/MessageBubble';
import { RunPanel } from './RunPanel';
import { hasAuthoritativeInputDraft } from '../../src/chat/composerDraftContract';
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

const COMPOSER_MAX_HEIGHT = 132;

export const App: React.FC = () => {
	// 共享 bundle 路由(grill R2-Q3):Run 面板与 Chat 共用 dist/webview.js,
	// 由 HTML 注入的 __CLASSMATE_ROUTE__ 决定渲染哪一棵组件树。
	// route 在页面生命周期内不变,提前 return 不违反 hooks 规则。
	if (getRoute() === 'run') {
		return <RunPanel />;
	}
	return <ChatApp />;
};

const ChatApp: React.FC = () => {
	const [state, setState] = useState<ChatState>(getInitialState);
	const [container, setContainer] = useState<'view' | 'panel'>(getContainer);
	const [llmConfig, setLlmConfig] = useState<LLMConfig | null>(null);
	const [showHistory, setShowHistory] = useState(false);
	const [pendingImages, setPendingImages] = useState<ChatImage[]>([]);
	const [pendingAttachments, setPendingAttachments] = useState<ChatAttachment[]>([]);
	const [showJumpToLatest, setShowJumpToLatest] = useState(false);
	// 镜像 textarea 是否"有可发送内容",仅用于按钮 disabled 状态。
	// 不参与 textarea 的受控渲染,只是 onInput / onSend 之后拨动一下。
	const [composerHasContent, setComposerHasContent] = useState<boolean>(
		(getInitialState().inputDraft.trim().length > 0)
	);
	const scrollRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const shouldScrollToBottomRef = useRef(true);
	// Composer is fully uncontrolled: the textarea's `.value` is owned by the DOM.
	// - React never sets `value` (only `defaultValue` on mount), so streaming
	//   re-renders / parent stateSync / IME composition can never clobber the
	//   text the user is typing.
	// - `inputDraftFromBackendRef` mirrors the latest inputDraft pushed by the
	//   backend; we sync it into the DOM only when the change is NOT a result
	//   of the user's own typing (i.e. conversation switch, attach, clear).
	//   We use a ref + useLayoutEffect instead of useEffect so the DOM update
	//   happens before the browser paints — no visible flicker.
	// - `suppressExternalSyncUntilChangeRef` lets the onChange handler arm a
	//   "user is editing" flag that blocks the next external inputDraft sync.
	const inputDraftFromBackendRef = useRef<string>(getInitialState().inputDraft);
	const suppressExternalSyncUntilChangeRef = useRef(false);
	// 后端契约:stateSync 默认剥离 inputDraft,只有显式携带的广播才是权威草稿。
	// 字段缺失时不能把它当成"草稿为空"去清空输入框。
	const hasAuthoritativeDraftRef = useRef<boolean>(
		hasAuthoritativeInputDraft(getInitialState())
	);
	// 程序设置 `el.value` 不会触发 input / change 事件,也不会让 ResizeObserver
	// 立即触发,所以手动设置 textarea 高度的地方(chooseQuickPrompt / handleSend)
	// 都必须显式调一次 autosize,否则高度会卡在旧值,直到下一次任意 state 变化。
	const autosize = useCallback(() => {
		const el = inputRef.current;
		if (!el) {
			return;
		}
		el.style.height = 'auto';
		el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT)}px`;
	}, []);

	useEffect(() => {
		// Request LLM config and theme on mount.
		sendMessage({ type: 'requestLLMConfig' });
		sendMessage({ type: 'requestTheme' });

		return subscribeToExtension((message: AnyExtensionToWebviewMessage) => {
			switch (message.type) {
				case 'stateSync':
					setState(message.state);
					hasAuthoritativeDraftRef.current =
						hasAuthoritativeInputDraft(message.state);
					if (hasAuthoritativeDraftRef.current) {
						inputDraftFromBackendRef.current = message.state.inputDraft ?? '';
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
				case 'themeUpdate':
					// 主题不经 React state:直接写根节点 CSS 自定义属性,浏览器把
					// 变化传播到所有 var() 引用处,已有控件零重渲染、零重挂载。
					applyClassMateTheme(message.theme);
					break;
			}
		});
	}, []);

	// Sync external inputDraft changes (conversation switch, attach, clear) into
	// the DOM — but never while the user is mid-edit.
	useLayoutEffect(() => {
		const el = inputRef.current;
		if (!el) {
			return;
		}
		if (!hasAuthoritativeDraftRef.current) {
			// 本次广播没有携带权威草稿(普通状态同步),不要用空串覆盖用户输入。
			return;
		}
		const backendDraft = state.inputDraft ?? '';
		if (backendDraft === el.value) {
			// Already in sync.
			return;
		}
		if (suppressExternalSyncUntilChangeRef.current) {
			// The user is actively typing — don't touch their DOM value. The
			// backend will catch up via inputDraftChanged messages.
			return;
		}
		el.value = backendDraft;
		setComposerHasContent(backendDraft.trim().length > 0);
		// Re-run autosize after the DOM value changed externally.
		autosize();
	}, [state.inputDraft, state.activeConversationId]);

	// 主题颜色经 themeUpdate 消息由 applyClassMateTheme 直接写入 CSS 变量
	// (含挂载时 requestTheme 的首次拉取),不走 React state,这里无需 effect。

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

	// ResizeObserver keeps the textarea height in sync with its DOM value
	// without involving React state at all — keystrokes never trigger a React
	// re-render, IME composition is never interrupted.
	useEffect(() => {
		const el = inputRef.current;
		if (!el) {
			return;
		}
		autosize();
		const ro = new ResizeObserver(autosize);
		ro.observe(el);
		// Also listen for direct input events so the very first keystroke
		// (before ResizeObserver fires) still gets a height update.
		const onInput = () => autosize();
		el.addEventListener('input', onInput);
		return () => {
			ro.disconnect();
			el.removeEventListener('input', onInput);
		};
	}, [autosize]);

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

	const handleInputChange = useCallback(() => {
		const el = inputRef.current;
		if (!el) {
			return;
		}
		const text = el.value;
		setComposerHasContent(text.trim().length > 0);
		// Mark that the user is editing; the external-sync useLayoutEffect will
		// see this and skip syncing the DOM until the user blurs / switches
		// conversation (which calls the explicit "arm flush" path below).
		suppressExternalSyncUntilChangeRef.current = true;
		sendMessage({ type: 'inputDraftChanged', text });
	}, []);

	const flushDraftBeforeNavigation = useCallback(() => {
		// 切会话/新建对话前:把当前 DOM 内容发到后端,确保后端草稿对得上用户刚才输入的字符。
		// 即便之前 onInput 已经发过 inputDraftChanged,这里的覆盖路径在最坏情况下
		// 只是写入相同的值,后端会幂等地更新 _state.inputDraft 和持久化记录。
		const el = inputRef.current;
		if (el) {
			sendMessage({ type: 'inputDraftChanged', text: el.value });
		}
		suppressExternalSyncUntilChangeRef.current = false;
	}, []);

	const handleSend = useCallback(
		(intent?: MessageIntent) => {
			const el = inputRef.current;
			const text = (el?.value ?? '').trim();
			if (!text && pendingImages.length === 0 && pendingAttachments.length === 0) {
				return;
			}
			if (el) {
				el.value = '';
				// 程序设值不会触发 input 事件 / ResizeObserver,手动收回高度。
				autosize();
			}
			suppressExternalSyncUntilChangeRef.current = false;
			setComposerHasContent(false);
			sendMessage({
				type: 'sendMessage',
				text: text || '请分析这些附件。',
				intent,
				images: pendingImages,
				attachments: pendingAttachments,
			});
			setPendingImages([]);
			setPendingAttachments([]);
			shouldScrollToBottomRef.current = true;
		},
		[pendingImages, pendingAttachments, autosize]
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
		const el = inputRef.current;
		if (!el) {
			return;
		}
		// 用户明确点 quick prompt → 覆盖是预期行为。
		// 但要先把当前 textarea 内容作为草稿 flush 到后端,这样:
		// - 后端拿到的是"覆盖前最后一刻"的真实文本,而不是覆盖后的 quick prompt 内容;
		// - 即使前端卡住 / 关闭,这个草稿也能从持久化恢复回来。
		// 紧接着再发一次 inputDraftChanged 把 quick prompt 的新内容同步给后端。
		sendMessage({ type: 'inputDraftChanged', text: el.value });
		el.value = text;
		el.setSelectionRange(text.length, text.length);
		autosize();
		suppressExternalSyncUntilChangeRef.current = false;
		setComposerHasContent(text.trim().length > 0);
		sendMessage({ type: 'inputDraftChanged', text });
		requestAnimationFrame(() => {
			inputRef.current?.focus();
			inputRef.current?.setSelectionRange(text.length, text.length);
		});
	}, [autosize]);

	const jumpToLatest = useCallback(() => {
		const el = scrollRef.current;
		if (!el) {
			return;
		}
		shouldScrollToBottomRef.current = true;
		setShowJumpToLatest(false);
		el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
	}, []);

	const canSend = composerHasContent || pendingImages.length > 0 || pendingAttachments.length > 0;

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
						className={`history-toggle icon-button ${showHistory ? 'expanded' : ''}`}
						title="查看历史会话"
						aria-expanded={showHistory}
					>
						历史
						<svg
							className="history-chevron"
							viewBox="0 0 16 16"
							width="12"
							height="12"
							aria-hidden="true"
						>
							<path fill="currentColor" d="M4 6l4 4 4-4l0.7 0.7L8 11.4 3.3 6.7z" />
						</svg>
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
							<div
								key={conversation.id}
								className={`history-item ${
									conversation.id === state.activeConversationId ? 'active' : ''
								}`}
							>
								<button
									onClick={() => {
										if (conversation.id === state.activeConversationId) {
											// 当前活跃会话被重复点击:仍然 flush 一次,确保
											// 用户最近一次输入(可能在 suppress 窗口中没到达后端)被同步。
											flushDraftBeforeNavigation();
											return;
										}
										flushDraftBeforeNavigation();
										sendMessage({ type: 'switchConversation', conversationId: conversation.id });
									}}
									className="history-item-main"
									title="切换到该会话"
								>
									<div className="history-title">{conversation.title}</div>
									<div className="history-date">
										{formatConversationDate(conversation.updatedAt)}
									</div>
								</button>
								<button
									onClick={() =>
										sendMessage({
											type: 'deleteConversation',
											conversationId: conversation.id,
										})
									}
									className="history-item-delete"
									title="删除该会话"
									aria-label="删除该会话"
									disabled={state.isStreaming}
								>
									×
								</button>
							</div>
						))}
					</div>
				)}
			</header>
			<div className="messages-shell">
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
							referenceExtractionPending={msg.id === state.referenceExtractionPendingFor}
						/>
					))}
				</div>
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
						onClick={() => sendMessage({ type: 'openLocalSettings' })}
						title="打开 ClassMate 设置"
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
					{/*
						关键: textarea 是真正"非受控"的。
						- React 只在挂载时通过 defaultValue 初始化,绝不写 value,
						  因此 IME 合成期间 React reconciliation / 父组件重渲染 /
						  父组件 stateSync / streaming appendToken 都无法改写用户输入。
						- 外部 inputDraft 变化(切会话/恢复草稿)通过 useLayoutEffect
						  写入 DOM,但仅当 suppressExternalSyncUntilChangeRef 为 false
						  (即用户没有正在打字)时才生效。
						- 拼音片段的更新由浏览器 IME 引擎自己绘制,和 React 完全无关,
						  因此不会再出现"英文缓存区跟不上手速"的问题。
					*/}
					<textarea
						ref={inputRef}
						rows={1}
						defaultValue={state.inputDraft}
						onInput={handleInputChange}
						onBlur={() => {
							// 让后续 backend 推送的 inputDraft 可以被接受
							// (之前我们在 input 期间抑制了外部同步)。
							suppressExternalSyncUntilChangeRef.current = false;
						}}
						onKeyDown={(event) => {
							if (event.key === 'Enter' && !event.shiftKey) {
								// 浏览器在 IME 合成期间 Enter 可能是选词,不要抢。
								// isComposing 已经被彻底移除,所以用 nativeEvent.isComposing 兜底。
								const native = (event.nativeEvent as InputEvent | KeyboardEvent);
								if (native && (native as InputEvent).isComposing) {
									return;
								}
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
							disabled={!canSend}
							className="primary-button"
						>
							发送
						</button>
					)}
				</div>
				<div className="composer-help">Enter 发送 · Shift+Enter 换行</div>
			</div>
		</div>
	);
};
