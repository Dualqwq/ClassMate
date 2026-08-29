import type { ChatState, ExtensionToWebviewMessage, WebviewToExtensionMessage } from '../../src/chat/types';
import type { JourneyExtensionToWebviewMessage, JourneyWebviewToExtensionMessage } from '../../src/chat/types';
import type { RunExtensionToWebviewMessage, RunWebviewToExtensionMessage } from '../../src/run/types';

declare const acquireVsCodeApi: () => {
	postMessage: (message: unknown) => void;
	/** webview 本地状态(随面板重载尽力恢复,与扩展宿主无关)。 */
	getState: () => unknown;
	/** webview 本地状态写入;某些宿主环境(测试)可能未实现,调用方需容忍失败。 */
	setState: (state: unknown) => void;
};

// VS Code only allows one call to acquireVsCodeApi() per webview. Keep a single
// module-level instance so send/subscribe never trigger it again.
const vscode = acquireVsCodeApi();

// 原生页面脚本(getChatWebviewHtml 注入的主题监听)经此桥回发 ack:
// acquireVsCodeApi 全局仅允许调用一次,这里把发送能力挂到 window 供
// bundle 之外的脚本使用,并冲销其在 bundle 加载前积压的回执(G5 第七轮)。
(window as unknown as { __classmatePostMessage?: (message: unknown) => void }).__classmatePostMessage =
	(message: unknown) => {
		vscode.postMessage(message);
	};
const pendingAcks = (window as unknown as { __classmatePendingAcks?: unknown[] }).__classmatePendingAcks;
if (pendingAcks) {
	for (const message of pendingAcks) {
		vscode.postMessage(message);
	}
	delete (window as unknown as { __classmatePendingAcks?: unknown[] }).__classmatePendingAcks;
}

declare global {
	interface Window {
		__CLASSMATE_INITIAL_STATE__?: ChatState;
		__CLASSMATE_CONTAINER__?: 'view' | 'panel';
		/** 共享 bundle 的路由(grill R2-Q3):缺省 chat;Run 面板注入 'run',
		 * Journey 面板注入 'journey'(#12a route 泛化)。 */
		__CLASSMATE_ROUTE__?: 'chat' | 'run' | 'journey';
	}
}

export function getContainer(): 'view' | 'panel' {
	return window.__CLASSMATE_CONTAINER__ ?? 'view';
}

export function getRoute(): 'chat' | 'run' | 'journey' {
	return window.__CLASSMATE_ROUTE__ ?? 'chat';
}

export function getInitialState(): ChatState {
	return (
		window.__CLASSMATE_INITIAL_STATE__ ?? {
			messages: [],
			inputDraft: '',
			isStreaming: false,
			currentStreamMessageId: null,
			processingStage: null,
			activeConversationId: 'initial',
			conversations: [],
		}
	);
}

export type AnyWebviewToExtensionMessage =
	| WebviewToExtensionMessage
	| RunWebviewToExtensionMessage
	| JourneyWebviewToExtensionMessage;
export type AnyExtensionToWebviewMessage =
	| ExtensionToWebviewMessage
	| RunExtensionToWebviewMessage
	| JourneyExtensionToWebviewMessage;

export function sendMessage(message: AnyWebviewToExtensionMessage): void {
	vscode.postMessage(message);
}

/**
 * webview 本地持久化读取(getState)。失败(宿主不支持/已释放)一律按
 * "无数据"降级返回 undefined,调用方自行走无持久化路径。
 */
export function readWebviewPersistedState(): unknown {
	try {
		return vscode.getState();
	} catch {
		return undefined;
	}
}

/**
 * webview 本地持久化写入(setState)。失败只意味着面板重载后走降级,
 * 不影响当前会话,故吞掉异常。
 */
export function writeWebviewPersistedState(state: unknown): void {
	try {
		vscode.setState(state);
	} catch {
		// 尽力而为:不持久化只损失"重载后还原映射"的便利,不影响安全性。
	}
}

export function subscribeToExtension(callback: (message: AnyExtensionToWebviewMessage) => void): () => void {
	const handler = (event: MessageEvent<AnyExtensionToWebviewMessage>) => {
		callback(event.data);
	};
	window.addEventListener('message', handler);
	// If state was already injected at page load, deliver it explicitly so
	// listeners don't miss it.
	const initialState = window.__CLASSMATE_INITIAL_STATE__;
	if (initialState) {
		callback({ type: 'stateSync', state: initialState });
	}
	return () => window.removeEventListener('message', handler);
}
