import { useEffect } from 'react';

declare const acquireVsCodeApi: () => {
	postMessage: (message: unknown) => void;
};

const vscode = acquireVsCodeApi();

export function useVsCode() {
	useEffect(() => {
		const handler = (event: MessageEvent) => {
			console.log('Message from extension:', event.data);
		};
		window.addEventListener('message', handler);
		return () => window.removeEventListener('message', handler);
	}, []);

	const sendMessage = (type: string, payload?: Record<string, unknown>) => {
		vscode.postMessage({ type, ...payload });
	};

	return { sendMessage };
}
