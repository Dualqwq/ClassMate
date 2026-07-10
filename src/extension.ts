import * as vscode from 'vscode';
import { ChatPanel } from './ui/ChatPanel';
import { ChatViewProvider } from './ui/ChatViewProvider';
import { ChatSession } from './chat/ChatSession';
import type { MessageIntent } from './chat/types';
import { chooseContainer } from './chat/MessageRouter';
import { setupApiKey, getApiKey } from './config/apiKey';
import { getLLMConfig, saveLLMConfig } from './config/llmConfig';

type ChatContainer = 'view' | 'panel';

function createChatPanel(
	session: ChatSession,
	extensionUri: vscode.Uri,
	onDidClose?: () => void,
	options?: { preserveFocus?: boolean }
): ChatPanel {
	let panel: ChatPanel;
	panel = ChatPanel.createOrShow(
		extensionUri,
		(message) => session.handleWebviewMessage(message),
		() => session.detach(panel),
		{ ...options, onDidClose }
	);
	session.attach(panel);
	return panel;
}

function createChatViewProvider(session: ChatSession, extensionUri: vscode.Uri): ChatViewProvider {
	const provider = new ChatViewProvider(
		extensionUri,
		(message) => session.handleWebviewMessage(message),
		() => session.detach(provider)
	);
	session.attach(provider);
	return provider;
}

function getContainerPreference(): 'auto' | 'view' | 'panel' {
	return vscode.workspace.getConfiguration('classmate').get('defaultContainer') ?? 'auto';
}

function showChatInContainer(
	session: ChatSession,
	extensionUri: vscode.Uri,
	chatViewProvider: ChatViewProvider,
	container: ChatContainer,
	options?: { preserveFocus?: boolean }
): void {
	if (container === 'panel') {
		if (ChatPanel.hasCurrent()) {
			// Panel already exists; just reveal it without pulling the view back.
			ChatPanel.revealCurrent(options?.preserveFocus ?? false);
		} else {
			chatViewProvider.reveal(true);
			createChatPanel(session, extensionUri, () => {
				// When the panel is closed by the user, fall back to sidebar view.
				void vscode.commands.executeCommand('classmate.focusChatView');
			}, options);
			// Defer closing sidebar so the panel has a moment to render and receive state.
			setTimeout(() => void vscode.commands.executeCommand('workbench.action.closeSidebar'), 50);
		}
	} else {
		chatViewProvider.reveal(options?.preserveFocus ?? false);
	}
}

function routeIntent(
	session: ChatSession,
	extensionUri: vscode.Uri,
	chatViewProvider: ChatViewProvider,
	intent: MessageIntent,
	userPrompt?: string
): void {
	const container = chooseContainer(intent, getContainerPreference());
	showChatInContainer(session, extensionUri, chatViewProvider, container);
	session.startIntentResponse(intent, userPrompt);
}

function createExplainSelectionHandler(
	session: ChatSession,
	extensionUri: vscode.Uri,
	chatViewProvider: ChatViewProvider
): () => void {
	return () => {
		const editor = vscode.window.activeTextEditor;
		const selection = editor?.selection;
		const selectedText = selection && !selection.isEmpty
			? editor.document.getText(selection)
			: '';
		const prompt = selectedText
			? `Explain this code:\n\n\`\`\`cpp\n${selectedText}\n\`\`\``
			: 'Explain the selected code.';
		routeIntent(session, extensionUri, chatViewProvider, 'code_explanation', prompt);
	};
}

function compileHandler(): void {
	void vscode.window.showInformationMessage('ClassMate compile command will run here.');
}

function runCodeHandler(): void {
	void vscode.window.showInformationMessage('ClassMate compile & run command will run here.');
}

function explainSelectionHandler(): void {
	void vscode.window.showInformationMessage('ClassMate explain selection will run here.');
}

function explainErrorHandler(): void {
	void vscode.window.showInformationMessage('ClassMate explain error will run here.');
}

function debugJourneyHandler(): void {
	void vscode.window.showInformationMessage('ClassMate Debug Journey will open here.');
}

async function setupApiKeyHandlerAsync(context: vscode.ExtensionContext): Promise<void> {
	await setupApiKey(context);
}

export function activate(context: vscode.ExtensionContext): void {
	console.log('ClassMate extension is now active.');

	const chatSession = ChatSession.getInstance();

	// Register the sidebar WebviewView provider.
	const chatViewProvider = createChatViewProvider(chatSession, context.extensionUri);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chatViewProvider)
	);

	// Track which container a message is currently targeting.
	let currentContainer: ChatContainer = 'view';

	// Route assistant message intents to the appropriate container.
	chatSession.setOnIntent((intent) => {
		const target = chooseContainer(intent, getContainerPreference(), currentContainer);
		if (target !== currentContainer) {
			currentContainer = target;
			showChatInContainer(chatSession, context.extensionUri, chatViewProvider, target, { preserveFocus: true });
		}
	});

	// Provide LLM config to webviews on request.
	chatSession.setOnRequestLLMConfig(() => getLLMConfig(context));

	// Save LLM config from webview to SecretStorage / globalState.
	chatSession.setOnSaveLLMConfig((provider, model, apiKey, apiUrl) => {
		void saveLLMConfig(context, provider as 'claude' | 'openai' | 'deepseek', model, apiKey, apiUrl)
			.then(() => getLLMConfig(context))
			.then((config) => {
				chatSession.setLLMConfig(config);
			});
	});

	// Seed initial LLM config into the session for placeholder debugging.
	void getLLMConfig(context).then((config) => chatSession.setLLMConfig(config));

	// Provide API key to ChatSession for LLM calls.
	chatSession.setOnGetApiKey(() => getApiKey(context));

	// Register all commands declared in package.json.
	const commands: { id: string; handler: (...args: unknown[]) => void }[] = [
		{
			id: 'classmate.openChat',
			handler: () => showChatInContainer(chatSession, context.extensionUri, chatViewProvider, currentContainer),
		},
		{
			id: 'classmate.openChatPanel',
			handler: () => {
				currentContainer = 'panel';
				showChatInContainer(chatSession, context.extensionUri, chatViewProvider, 'panel');
			},
		},
		{
			id: 'classmate.focusChatView',
			handler: () => {
				currentContainer = 'view';
				ChatPanel.closeCurrent();
				chatViewProvider.reveal(false);
			},
		},
		{
			id: 'classmate.hideChatView',
			handler: () => {
				ChatPanel.closeCurrent(true);
				void vscode.commands.executeCommand('workbench.action.closeSidebar');
			},
		},
		{
			id: 'classmate.toggleChatContainer',
			handler: () => {
				currentContainer = currentContainer === 'view' ? 'panel' : 'view';
				showChatInContainer(chatSession, context.extensionUri, chatViewProvider, currentContainer);
			},
		},
		{ id: 'classmate.compile', handler: compileHandler },
		{ id: 'classmate.runCode', handler: runCodeHandler },
		{
			id: 'classmate.explainSelection',
			handler: createExplainSelectionHandler(chatSession, context.extensionUri, chatViewProvider),
		},
		{
			id: 'classmate.explainError',
			handler: () => routeIntent(chatSession, context.extensionUri, chatViewProvider, 'error_explanation'),
		},
		{ id: 'classmate.debugJourney', handler: debugJourneyHandler },
		{ id: 'classmate.setupApiKey', handler: () => setupApiKeyHandlerAsync(context) }, 
	];

	for (const { id, handler } of commands) {
		context.subscriptions.push(vscode.commands.registerCommand(id, handler));
	}

	// Status bar: compile & run button (visible when a C++ file is active).
	const compileRunStatusBarItem = vscode.window.createStatusBarItem(
		vscode.StatusBarAlignment.Left,
		100
	);
	compileRunStatusBarItem.command = 'classmate.runCode';
	compileRunStatusBarItem.text = '$(run) ClassMate: Run';
	compileRunStatusBarItem.tooltip = 'Compile and run the current C++ file';
	compileRunStatusBarItem.show();
	context.subscriptions.push(compileRunStatusBarItem);

	// Status bar: open chat button.
	const chatStatusBarItem = vscode.window.createStatusBarItem(
		vscode.StatusBarAlignment.Right,
		100
	);
	chatStatusBarItem.command = 'classmate.openChat';
	chatStatusBarItem.text = '$(comment-discussion) ClassMate';
	chatStatusBarItem.tooltip = 'Open ClassMate chat';
	chatStatusBarItem.show();
	context.subscriptions.push(chatStatusBarItem);
}

export function deactivate(): void {
	console.log('ClassMate extension is deactivated.');
}
