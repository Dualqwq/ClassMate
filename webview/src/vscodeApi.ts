import type { ChatState, ExtensionToWebviewMessage, WebviewToExtensionMessage } from '../../src/chat/types';
import type { RunExtensionToWebviewMessage, RunWebviewToExtensionMessage } from '../../src/run/types';

declare const acquireVsCodeApi: () => {
	postMessage: (message: unknown) => void;
};

// VS Code only allows one call to acquireVsCodeApi() per webview. Keep a single
// module-level instance so send/subscribe never trigger it again.
const vscode = acquireVsCodeApi();

declare global {
	interface Window {
		__CLASSMATE_INITIAL_STATE__?: ChatState;
		__CLASSMATE_CONTAINER__?: 'view' | 'panel';
		/** 共享 bundle 的路由(grill R2-Q3):缺省 chat;Run 面板注入 'run'。 */
		__CLASSMATE_ROUTE__?: 'chat' | 'run';
	}
}

export function getContainer(): 'view' | 'panel' {
	return window.__CLASSMATE_CONTAINER__ ?? 'view';
}

export function getRoute(): 'chat' | 'run' {
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

export type AnyWebviewToExtensionMessage = WebviewToExtensionMessage | RunWebviewToExtensionMessage;
export type AnyExtensionToWebviewMessage = ExtensionToWebviewMessage | RunExtensionToWebviewMessage;

export function sendMessage(message: AnyWebviewToExtensionMessage): void {
	vscode.postMessage(message);
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
