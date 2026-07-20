import type { ChatState, ExtensionToWebviewMessage, WebviewToExtensionMessage } from '../../src/chat/types';

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
	}
}

export function getContainer(): 'view' | 'panel' {
	return window.__CLASSMATE_CONTAINER__ ?? 'view';
}

export function getInitialState(): ChatState {
	return (
		window.__CLASSMATE_INITIAL_STATE__ ?? {
			messages: [],
			inputDraft: '',
			isStreaming: false,
			currentStreamMessageId: null,
			activeConversationId: 'initial',
			conversations: [],
		}
	);
}

export function sendMessage(message: WebviewToExtensionMessage): void {
	vscode.postMessage(message);
}

export function subscribeToExtension(callback: (message: ExtensionToWebviewMessage) => void): () => void {
	const handler = (event: MessageEvent<ExtensionToWebviewMessage>) => {
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
