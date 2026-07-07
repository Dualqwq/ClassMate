import type { ChatState, ExtensionToWebviewMessage, WebviewToExtensionMessage } from '../../src/chat/types';

declare const acquireVsCodeApi: () => {
	postMessage: (message: unknown) => void;
};

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
		}
	);
}

export function sendMessage(message: WebviewToExtensionMessage): void {
	const vscode = acquireVsCodeApi();
	vscode.postMessage(message);
}

export function subscribeToExtension(callback: (message: ExtensionToWebviewMessage) => void): () => void {
	const vscode = acquireVsCodeApi();
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
