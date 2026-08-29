import * as React from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ChatAttachment, ChatImage, ChatState, LLMConfig, MessageIntent } from '../../src/chat/types';
import {
	buildPasteToken,
	countLines,
	expandPasteTokens,
	findActivePasteTokens,
	findBrokenPasteFragments,
	findRemovedPasteTokens,
	findUniquePasteSerial,
	parsePasteToken,
	shouldCollapsePaste,
	type ComposerPasteRecord,
} from '../../src/chat/composerPasteCollapse';
import { applyClassMateTheme } from '../../src/chat/classmateTheme';
import {
	getInitialState,
	getContainer,
	getRoute,
	sendMessage,
	subscribeToExtension,
	readWebviewPersistedState,
	writeWebviewPersistedState,
	type AnyExtensionToWebviewMessage,
} from './vscodeApi';
import { MessageBubble } from './components/MessageBubble';
import { RunPanel } from './RunPanel';
import { JourneyView } from './journey/JourneyView';
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
	{
		// #13 后半复习入口(A1):预填 §4.4 拍板文案,与扩展侧
		// REVIEW_REQUEST_DRAFT 同稿(此处为 webview 本地常量,零消息)。
		title: '复习我最近常犯的错',
		description: '把反复出错的知识点串起来讲一遍',
		text: '帮我复盘一下最近的错题:把我反复出错的几个知识点串起来讲一遍。\n每个先说我当时错在哪,再讲怎么检查,最后给我一个可以自己再试一次的小方向就好,先不要给完整代码。',
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

// ---- 粘贴折叠(App 侧参数;阈值与 token 逻辑在 src/chat/composerPasteCollapse.ts)----
/** 内存映射条目上限:按插入顺序淘汰最旧,防止长会话里大段原文无界驻留。 */
const PASTE_MAP_MAX_ENTRIES = 50;
/** 持久化到 vscode.setState 的原文总字符上限:超过则跳过本次持久化
 * (保留上一次成功快照),当前会话的内存映射不受影响。 */
const PASTE_PERSIST_MAX_TOTAL_CHARS = 500_000;
/** 「已移除/已折叠」等即时提示的自动消失时长;错误提示不自动消失。 */
const PASTE_NOTICE_AUTO_DISMISS_MS = 6000;

/** 占位 chips 的渲染数据(从当前输入框值 + 映射派生)。 */
interface ActivePasteChip {
	token: string;
	serial: number;
	lineCount: number;
	/** 映射里是否还有原文;false = 失效占位(重载降级等)。 */
	mapped: boolean;
}

export const App: React.FC = () => {
	// 共享 bundle 路由(grill R2-Q3):Chat / Run / Journey(#12a)共用 dist/webview.js,
	// 由 HTML 注入的 __CLASSMATE_ROUTE__ 决定渲染哪一棵组件树。
	// route 在页面生命周期内不变,提前 return 不违反 hooks 规则。
	if (getRoute() === 'run') {
		return <RunPanel />;
	}
	if (getRoute() === 'journey') {
		return <JourneyView />;
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

	// ---- 粘贴折叠状态(全部属于显示层;发送前必然还原完整原文) ----
	// token → 原文映射,按「会话 id + token」作键(见 pasteMapKeyFor),同一
	// token 字符串在不同会话的草稿里互不串映射。token 被删除后条目刻意保留:
	// 用户误删后 Ctrl+Z 恢复 token 时无需重贴;过期条目由容量上限淘汰。
	const pasteContentsRef = useRef<Map<string, ComposerPasteRecord>>(new Map());
	const nextPasteSerialRef = useRef(1);
	const pasteStateRestoredRef = useRef(false);
	// textarea 上一帧值:用户输入事件据此 diff 检测"占位被删除/残缺"。
	// 所有程序化写入(外部草稿同步/quick prompt/发送清空/粘贴插入兜底)都
	// 必须同步更新它,否则下一次用户输入会被误判成批量删除。
	const lastComposerValueRef = useRef<string>(getInitialState().inputDraft);
	const [activePastes, setActivePastes] = useState<ActivePasteChip[]>([]);
	const [composerNotice, setComposerNotice] = useState<{
		kind: 'info' | 'error';
		text: string;
	} | null>(null);
	const [previewingPaste, setPreviewingPaste] = useState<ComposerPasteRecord | null>(null);
	const noticeTimerRef = useRef<number | null>(null);

	// 面板重载后从 webview 本地持久化恢复映射(尽力而为,仅首帧执行一次)。
	// 恢复成功 → 草稿里的 token 继续可用;恢复失败/无数据 → 降级:token 原样
	// 可见、发送被拦截并提示,绝不静默吞内容。持久化数据形态异常也按降级处理。
	if (!pasteStateRestoredRef.current) {
		pasteStateRestoredRef.current = true;
		try {
			const persisted = readWebviewPersistedState() as
				| { composerPaste?: { nextSerial?: unknown; entries?: unknown } }
				| undefined;
			const entries = persisted?.composerPaste?.entries;
			if (Array.isArray(entries)) {
				for (const entry of entries) {
					if (!Array.isArray(entry) || entry.length !== 2) {
						continue;
					}
					const [token, record] = entry as [unknown, unknown];
					if (typeof token !== 'string' || !parsePasteToken(token)) {
						continue;
					}
					if (
						typeof record !== 'object' ||
						record === null ||
						typeof (record as ComposerPasteRecord).content !== 'string' ||
						typeof (record as ComposerPasteRecord).lineCount !== 'number' ||
						typeof (record as ComposerPasteRecord).serial !== 'number'
					) {
						continue;
					}
					pasteContentsRef.current.set(token, record as ComposerPasteRecord);
				}
			}
			let maxRestoredSerial = 0;
			for (const record of pasteContentsRef.current.values()) {
				maxRestoredSerial = Math.max(maxRestoredSerial, record.serial);
			}
			const persistedNextSerial = persisted?.composerPaste?.nextSerial;
			nextPasteSerialRef.current = Math.max(
				1,
				typeof persistedNextSerial === 'number' ? Math.floor(persistedNextSerial) : 1,
				maxRestoredSerial + 1
			);
		} catch {
			// 任何持久化形态异常都按"无映射"降级,绝不阻断输入框使用。
		}
	}

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

	// ---- 粘贴折叠辅助(persist / notice / chips) ----
	const pasteMapKeyFor = useCallback((conversationId: string, token: string) => {
		// 同一 token 字符串可能先后出现在不同会话的草稿里(重载降级后再粘贴
		// 出同编号同行数的占位等);按会话分键保证互相串不到对方的原文。
		return `${conversationId}\u0000${token}`;
	}, []);

	const persistPasteMap = useCallback(() => {
		const entries = Array.from(pasteContentsRef.current.entries());
		let totalChars = 0;
		for (const [, record] of entries) {
			totalChars += record.content.length;
		}
		// 超上限时跳过本次写入(保留上一次成功快照),内存映射照常工作。
		if (totalChars > PASTE_PERSIST_MAX_TOTAL_CHARS) {
			return;
		}
		try {
			const previous = (readWebviewPersistedState() ?? {}) as Record<string, unknown>;
			writeWebviewPersistedState({
				...previous,
				composerPaste: { nextSerial: nextPasteSerialRef.current, entries },
			});
		} catch {
			// 持久化失败只损失"重载后还原映射"的便利,不影响当前会话。
		}
	}, []);

	const showComposerNotice = useCallback((kind: 'info' | 'error', text: string) => {
		if (noticeTimerRef.current !== null) {
			window.clearTimeout(noticeTimerRef.current);
			noticeTimerRef.current = null;
		}
		setComposerNotice({ kind, text });
		if (kind === 'info') {
			noticeTimerRef.current = window.setTimeout(() => {
				noticeTimerRef.current = null;
				setComposerNotice(null);
			}, PASTE_NOTICE_AUTO_DISMISS_MS);
		}
	}, []);

	useEffect(() => {
		return () => {
			if (noticeTimerRef.current !== null) {
				window.clearTimeout(noticeTimerRef.current);
			}
		};
	}, []);

	const refreshActivePastes = useCallback(() => {
		const value = inputRef.current?.value ?? '';
		const chips: ActivePasteChip[] = [];
		for (const token of findActivePasteTokens(value)) {
			const record = pasteContentsRef.current.get(pasteMapKeyFor(state.activeConversationId, token));
			const info = parsePasteToken(token);
			chips.push({
				token,
				serial: record?.serial ?? info?.serial ?? 0,
				lineCount: record?.lineCount ?? info?.lineCount ?? 0,
				mapped: record !== undefined,
			});
		}
		setActivePastes(chips);
	}, [state.activeConversationId, pasteMapKeyFor]);

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
					// 幂等兜底:原生页面脚本(getChatWebviewHtml 注入)已先行应用并
					// 负责 ack 回执;这里重复应用无害,仅覆盖 bundle 晚于首条消息
					// 到达前原生层尚未监听的极端时序。
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
		// 会话切换后即使草稿文本与框内相同,也要刷新占位 chips:映射按会话
		// 分键,同一 token 字符串在两个会话的映射状态可能不同。
		refreshActivePastes();
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
		// 程序化写入:同步上一帧值镜像并刷新占位 chips,否则下一次用户输入
		// 会被 diff 误判成"批量删除占位"。
		lastComposerValueRef.current = backendDraft;
		refreshActivePastes();
		setComposerHasContent(backendDraft.trim().length > 0);
		// Re-run autosize after the DOM value changed externally.
		autosize();
	}, [state.inputDraft, state.activeConversationId, refreshActivePastes, autosize]);

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
		const previousValue = lastComposerValueRef.current;
		lastComposerValueRef.current = text;
		// 删除占位反馈:diff 检测被移除的占位并给可感知提示。映射条目刻意
		// 不删——用户误删后 Ctrl+Z 恢复 token 时原文仍在;过期条目由容量
		// 上限与发送清理淘汰。删除即"该段原文不会随消息发送"(还原按框内
		// 现存 token 扫描,token 不在就不发),语义天然成立。
		const removedTokens = findRemovedPasteTokens(previousValue, text);
		if (removedTokens.length > 0) {
			const described = removedTokens
				.map((token) => parsePasteToken(token))
				.filter((info): info is NonNullable<typeof info> => info !== undefined)
				.map((info) => `#${info.serial}（${info.lineCount} 行）`);
			showComposerNotice(
				'info',
				described.length > 0
					? `已移除粘贴内容 ${described.join('、')}，对应原文不会随消息发送。`
					: '已移除粘贴内容，对应原文不会随消息发送。'
			);
		} else if (composerNotice?.kind === 'error') {
			// 之前的错误(占位失效/残缺)可能已被用户修好:重新检查,解除即清。
			const expansion = expandPasteTokens(text, (token) =>
				pasteContentsRef.current.get(pasteMapKeyFor(state.activeConversationId, token))?.content
			);
			if (expansion.missingTokens.length === 0 && findBrokenPasteFragments(text).length === 0) {
				setComposerNotice(null);
			}
		}
		setComposerHasContent(text.trim().length > 0);
		// Mark that the user is editing; the external-sync useLayoutEffect will
		// see this and skip syncing the DOM until the user blurs / switches
		// conversation (which calls the explicit "arm flush" path below).
		suppressExternalSyncUntilChangeRef.current = true;
		refreshActivePastes();
		sendMessage({ type: 'inputDraftChanged', text });
	}, [composerNotice, state.activeConversationId, pasteMapKeyFor, refreshActivePastes, showComposerNotice]);

	const handleComposerPaste = useCallback(
		(event: React.ClipboardEvent<HTMLTextAreaElement>) => {
			const clipboardText = event.clipboardData.getData('text/plain');
			// 短文本/空粘贴(如纯图片)走浏览器默认行为,零感知。
			if (!clipboardText || !shouldCollapsePaste(clipboardText)) {
				return;
			}
			const el = event.currentTarget;
			const lineCount = countLines(clipboardText);
			// 编号在"当前框内 token + 当前会话映射键"里去重:撞车会让两处占位
			// 共享同一份映射,发送时还原出错内容。
			const serial = findUniquePasteSerial(
				(token) =>
					el.value.includes(token) ||
					pasteContentsRef.current.has(pasteMapKeyFor(state.activeConversationId, token)),
				nextPasteSerialRef.current,
				lineCount
			);
			nextPasteSerialRef.current = serial + 1;
			const token = buildPasteToken(serial, lineCount);
			// 容量淘汰:映射条目按插入顺序,淘汰最旧(其占位多半早已不在框内)。
			while (pasteContentsRef.current.size >= PASTE_MAP_MAX_ENTRIES) {
				const oldest = pasteContentsRef.current.keys().next();
				if (oldest.done) {
					break;
				}
				pasteContentsRef.current.delete(oldest.value);
			}
			pasteContentsRef.current.set(pasteMapKeyFor(state.activeConversationId, token), {
				content: clipboardText,
				lineCount,
				serial,
			});
			persistPasteMap();
			event.preventDefault();
			// execCommand 走浏览器原生插入:遵守当前选区(替换选区 = 标准粘贴
			// 语义)、保留原生撤销栈,并同步派发 input 事件,让既有的草稿同步/
			// autosize/composerHasContent 链路原样工作。execCommand 虽已标记
			// 废弃,但在 VS Code webview(Chromium)内可用,且是唯一能保留
			// undo 栈的插入方式;setRangeText 兜底不具备这两点。
			let inserted = false;
			try {
				inserted = document.execCommand('insertText', false, token);
			} catch {
				inserted = false;
			}
			if (!inserted) {
				// 兜底:setRangeText 不触发 input 事件,手动补一遍同步。
				const start = el.selectionStart ?? el.value.length;
				const end = el.selectionEnd ?? start;
				el.setRangeText(token, start, end, 'end');
				lastComposerValueRef.current = el.value;
				setComposerHasContent(el.value.trim().length > 0);
				refreshActivePastes();
				autosize();
				suppressExternalSyncUntilChangeRef.current = true;
				sendMessage({ type: 'inputDraftChanged', text: el.value });
			}
			showComposerNotice(
				'info',
				`已折叠粘贴内容 #${serial}（${lineCount} 行），发送时自动附完整原文，点击占位可查看。`
			);
		},
		[state.activeConversationId, pasteMapKeyFor, persistPasteMap, refreshActivePastes, showComposerNotice, autosize]
	);

	const handlePreviewPaste = useCallback(
		(token: string) => {
			const record = pasteContentsRef.current.get(pasteMapKeyFor(state.activeConversationId, token));
			if (!record) {
				showComposerNotice(
					'error',
					'该粘贴占位已失效：原内容不在本面板中，无法预览。请删除该占位或重新粘贴。'
				);
				return;
			}
			setPreviewingPaste(record);
		},
		[state.activeConversationId, pasteMapKeyFor, showComposerNotice]
	);

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
			const rawValue = el?.value ?? '';
			// 发送前把占位 token 还原为完整原文——模型必须收到完整内容,
			// 占位只是显示层。还原在 webview 侧完成,仍走既有 sendMessage 通路。
			const expansion = expandPasteTokens(rawValue, (token) =>
				pasteContentsRef.current.get(pasteMapKeyFor(state.activeConversationId, token))?.content
			);
			// 底线一:无映射的占位(面板重载降级/手打同形文本)绝不静默发出,
			// 宁可拦截并提示,也不把残缺内容发给模型。
			if (expansion.missingTokens.length > 0) {
				showComposerNotice(
					'error',
					`粘贴占位已失效（${expansion.missingTokens.join('、')}），无法还原原文。请删除该占位或重新粘贴后再发送。`
				);
				return;
			}
			// 底线二:残缺占位(被部分编辑、匹配不上 token 模式)若放行会以
			// 字面文本发出、原文被静默丢弃,同样拦截。
			if (findBrokenPasteFragments(rawValue).length > 0) {
				showComposerNotice(
					'error',
					'有粘贴占位被改动得不完整，请按 Ctrl+Z 撤销或删除整个占位后再发送。'
				);
				return;
			}
			const text = expansion.text.trim();
			if (!text && pendingImages.length === 0 && pendingAttachments.length === 0) {
				return;
			}
			if (el) {
				el.value = '';
				// 程序设值不会触发 input 事件 / ResizeObserver,手动收回高度。
				lastComposerValueRef.current = '';
				autosize();
			}
			// 已随消息发出的占位不再需要映射,清理释放内存并同步持久化。
			let removedSentTokens = false;
			for (const token of findActivePasteTokens(rawValue)) {
				pasteContentsRef.current.delete(pasteMapKeyFor(state.activeConversationId, token));
				removedSentTokens = true;
			}
			if (removedSentTokens) {
				refreshActivePastes();
				persistPasteMap();
			}
			suppressExternalSyncUntilChangeRef.current = false;
			setComposerHasContent(false);
			setComposerNotice(null);
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
		[
			pendingImages,
			pendingAttachments,
			autosize,
			state.activeConversationId,
			pasteMapKeyFor,
			showComposerNotice,
			refreshActivePastes,
			persistPasteMap,
		]
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
		// 程序化覆盖:同步上一帧值镜像并刷新占位 chips。覆盖前已把含占位的
		// 旧草稿 flush 到后端,映射条目保留——切回该会话时占位仍可还原。
		lastComposerValueRef.current = text;
		refreshActivePastes();
		el.setSelectionRange(text.length, text.length);
		autosize();
		suppressExternalSyncUntilChangeRef.current = false;
		setComposerHasContent(text.trim().length > 0);
		sendMessage({ type: 'inputDraftChanged', text });
		requestAnimationFrame(() => {
			inputRef.current?.focus();
			inputRef.current?.setSelectionRange(text.length, text.length);
		});
	}, [autosize, refreshActivePastes]);

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
				{composerNotice && (
					<div
						className={`composer-notice ${composerNotice.kind === 'error' ? 'composer-notice-error' : 'composer-notice-info'}`}
						role="status"
					>
						{composerNotice.text}
					</div>
				)}
				{activePastes.length > 0 && (
					<div className="paste-chips">
						{activePastes.map((paste) => (
							<button
								key={paste.token}
								className={`paste-chip${paste.mapped ? '' : ' paste-chip-orphan'}`}
								onClick={() => handlePreviewPaste(paste.token)}
								title={
									paste.mapped
										? `查看粘贴 #${paste.serial} 的完整内容（${paste.lineCount} 行）`
										: '占位已失效：原内容不在本面板中，请删除该占位或重新粘贴'
								}
							>
								{paste.mapped
									? `已粘贴 #${paste.serial} · ${paste.lineCount} 行`
									: `已失效 ${paste.token}`}
							</button>
						))}
					</div>
				)}
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
						onPaste={handleComposerPaste}
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
			{previewingPaste && (
				<div className="paste-preview-overlay" onClick={() => setPreviewingPaste(null)}>
					<div
						className="paste-preview"
						role="dialog"
						aria-modal="true"
						aria-label="粘贴内容预览"
						onClick={(event) => event.stopPropagation()}
					>
						<div className="paste-preview-header">
							<span>{`粘贴 #${previewingPaste.serial} · ${previewingPaste.lineCount} 行`}</span>
							<button
								className="paste-preview-close"
								onClick={() => setPreviewingPaste(null)}
								title="关闭"
								aria-label="关闭预览"
							>
								×
							</button>
						</div>
						<pre className="paste-preview-body">{previewingPaste.content}</pre>
					</div>
				</div>
			)}
		</div>
	);
};
