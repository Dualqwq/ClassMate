import * as vscode from 'vscode';
import { spawnSync } from 'child_process';
import { ChatPanel } from './ui/ChatPanel';
import { ChatViewProvider } from './ui/ChatViewProvider';
import { registerInlineExplainButton } from './ui/inlineExplainButton';
import { ChatSession } from './chat/ChatSession';
import type { MessageIntent } from './chat/types';
import { chooseContainer } from './chat/MessageRouter';
import { setupApiKey, getApiKey } from './config/apiKey';
import { getLLMConfig, saveLLMConfig } from './config/llmConfig';
import { isLanguageEnabled, onEnabledLanguagesChanged } from './config/languageConfig';
import { checkGppAvailability, spawnGpp } from './compiler/compilerService';
import { registerCompileOutputProvider, showCompileOutput, COMPILE_OUTPUT_SCHEME } from './compiler/outputPanel';
import { extractErrorLocation } from './error/errorParser';
import { matchErrorToKnowledge } from './error/errorKnowledgeMap';
import { createSkillLoader } from './prompts/promptLoader';
import { SystemPromptBuilder } from './prompts/systemPromptBuilder';

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
	chatViewProvider: ChatViewProvider,
	selectedText?: string,
	languageId?: string
): () => void {
	return () => {
		const editor = vscode.window.activeTextEditor;
		const selection = editor?.selection;
		const text = selectedText ?? (selection && !selection.isEmpty
			? editor.document.getText(selection)
			: '');
		const lang = languageId ?? editor?.document.languageId ?? 'text';

		if (!text) {
			void vscode.window.showInformationMessage('Please select some code first.');
			return;
		}

		if (lang === COMPILE_OUTPUT_SCHEME) {
			const parsed = extractErrorLocation(text);
			const knowledge = matchErrorToKnowledge(parsed?.message ?? text);
			const knowledgeText = knowledge.length > 0
				? knowledge.map((k) => `- ${k.tag}: ${k.message}`).join('\n')
				: 'No specific knowledge tag matched.';

			const prompt = [
				'Explain this compile error in beginner-friendly language:',
				'',
				`Raw error: ${text}`,
				parsed
					? `Location: ${parsed.file ?? 'unknown'}:${parsed.line ?? '?'}:${parsed.column ?? '?'}`
					: 'Location: could not parse',
				'',
				'Matched knowledge tags:',
				knowledgeText,
			].join('\n');

			routeIntent(session, extensionUri, chatViewProvider, 'error_explanation', prompt);
			return;
		}

		if (!isLanguageEnabled(lang)) {
			void vscode.window.showInformationMessage(
				`ClassMate is not enabled for language "${lang}". Add it to classmate.enabledLanguages in settings.`
			);
			return;
		}

		const prompt = `Explain this code:\n\n\`\`\`${lang}\n${text}\n\`\`\``;
		routeIntent(session, extensionUri, chatViewProvider, 'code_explanation', prompt);
	};
}

async function compileHandlerAsync(): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	if (!editor || !isLanguageEnabled(editor.document.languageId)) {
		void vscode.window.showInformationMessage('ClassMate compile is not enabled for this file type.');
		return;
	}

	const document = editor.document;
	if (document.isDirty && !(await document.save())) {
		void vscode.window.showWarningMessage('Could not save the current file before compiling.');
		return;
	}

	if (!checkGppAvailability()) {
		void vscode.window.showWarningMessage(
			'g++ was not found on PATH. Please install MinGW (Windows) or Xcode/Clang (macOS) or build-essential (Linux).'
		);
		return;
	}

	try {
		const result = await spawnGpp(document.fileName);
		const output = [
			`Compiled: ${document.fileName}`,
			`Exit code: ${result.exitCode ?? 'killed'}`,
			`Duration: ${result.durationMs}ms`,
			result.stdout ? `\n--- stdout ---\n${result.stdout}` : '',
			result.stderr ? `\n--- stderr ---\n${result.stderr}` : '',
		]
			.filter(Boolean)
			.join('\n');

		await showCompileOutput(output);
	} catch (error) {
		void vscode.window.showErrorMessage(`Compilation failed: ${String(error)}`);
	}
}

const CLASSMATE_RUN_TERMINAL_NAME = 'ClassMate Run';

function runInTerminal(executablePath: string): void {
	// Reuse an existing ClassMate Run terminal if one is open.
	const existing = vscode.window.terminals.find(
		(terminal) => terminal.name === CLASSMATE_RUN_TERMINAL_NAME
	);
	const terminal = existing ?? createClassMateTerminal();

	const shellPath = getTerminalShellPath(terminal);
	const isPowerShell = isPowerShellPath(shellPath);

	// PowerShell needs the call operator '&' to run a quoted executable path.
	const command = isPowerShell
		? `& "${executablePath}"`
		: `"${executablePath}"`;

	terminal.sendText(command, true);
	terminal.show(true);
}

function getTerminalShellPath(terminal: vscode.Terminal): string | undefined {
	const options = terminal.creationOptions as vscode.TerminalOptions | undefined;
	return options?.shellPath;
}

function isPowerShellPath(shellPath: string | undefined): boolean {
	if (!shellPath) {
		return process.platform === 'win32';
	}
	const lower = shellPath.toLowerCase();
	return lower.includes('powershell') || lower.includes('pwsh');
}

function createClassMateTerminal(): vscode.Terminal {
	if (process.platform === 'win32') {
		// Prefer PowerShell on Windows; fall back to cmd if pwsh/powershell is unavailable.
		const shellPath = findWindowsShell();
		return vscode.window.createTerminal({
			name: CLASSMATE_RUN_TERMINAL_NAME,
			shellPath,
		});
	}

	// Prefer bash on Unix-like systems; fall back to sh.
	const shellPath = findUnixShell();
	return vscode.window.createTerminal({
		name: CLASSMATE_RUN_TERMINAL_NAME,
			shellPath,
	});
}

function findWindowsShell(): string {
	for (const candidate of ['pwsh.exe', 'powershell.exe', 'cmd.exe']) {
		if (commandExistsOnPath(candidate)) {
			return candidate;
		}
	}
	return 'cmd.exe';
}

function findUnixShell(): string {
	for (const candidate of ['/bin/bash', '/usr/bin/bash', '/bin/sh']) {
		if (commandExistsOnPath(candidate)) {
			return candidate;
		}
	}
	return '/bin/sh';
}

function commandExistsOnPath(command: string): boolean {
    if (process.platform === 'win32') {
        // Use 'where' to locate the executable on PATH. This is more reliable than
        // running the program because not every executable supports --version and
        // PowerShell parameter parsing can return non-zero exit codes.
        try {
            const result = spawnSync('where', [command], {
                windowsHide: true,
                shell: true,
            });
            return result.status === 0 && (result.stdout?.toString().trim().length ?? 0) > 0;
        } catch {
            return false;
        }
    }

    // On Unix-like systems, 'command -v' is POSIX-compliant and reliable.
    try {
        const result = spawnSync('command', ['-v', command], {
            windowsHide: true,
            shell: true,
        });
        return result.status === 0;
    } catch {
        return false;
    }
}

async function runCodeHandlerAsync(): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	if (!editor || !isLanguageEnabled(editor.document.languageId)) {
		void vscode.window.showInformationMessage('ClassMate compile & run is not enabled for this file type.');
		return;
	}

	const document = editor.document;
	if (document.isDirty && !(await document.save())) {
		void vscode.window.showWarningMessage('Could not save the current file before compiling.');
		return;
	}

	if (!checkGppAvailability()) {
		void vscode.window.showWarningMessage(
			'g++ was not found on PATH. Please install MinGW (Windows) or Xcode/Clang (macOS) or build-essential (Linux).'
		);
		return;
	}

	try {
		const compileResult = await spawnGpp(document.fileName);
		if (compileResult.exitCode !== 0) {
			const output = [
				`Compiled: ${document.fileName}`,
				`Exit code: ${compileResult.exitCode ?? 'killed'}`,
				`Duration: ${compileResult.durationMs}ms`,
				compileResult.stdout ? `\n--- compile stdout ---\n${compileResult.stdout}` : '',
				compileResult.stderr ? `\n--- compile stderr ---\n${compileResult.stderr}` : '',
			]
				.filter(Boolean)
				.join('\n');
			await showCompileOutput(output);
			return;
		}

		// Compilation succeeded: run the executable in an interactive terminal.
		runInTerminal(compileResult.outputPath);
	} catch (error) {
		void vscode.window.showErrorMessage(`Compile & run failed: ${String(error)}`);
	}
}

function compileHandler(): void {
	void compileHandlerAsync();
}

function runCodeHandler(): void {
	void runCodeHandlerAsync();
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

const CODE_LENS_HINT_KEY = 'classmate.codeLensHintShown';

async function promptToEnableCodeLens(context: vscode.ExtensionContext): Promise<void> {
	const shown = context.globalState.get<boolean>(CODE_LENS_HINT_KEY, false);
	if (shown) {
		return;
	}

	const codeLensEnabled = vscode.workspace.getConfiguration('editor').get<boolean>('codeLens', true);
	if (codeLensEnabled) {
		return;
	}

	const choice = await vscode.window.showInformationMessage(
		'ClassMate can show an inline "Explain" button above your selections if CodeLens is enabled. Enable it now?',
		'Enable',
		'Don\'t ask again'
	);

	await context.globalState.update(CODE_LENS_HINT_KEY, true);

	if (choice === 'Enable') {
		await vscode.workspace.getConfiguration('editor').update('codeLens', true, true);
	}
}

export function activate(context: vscode.ExtensionContext): void {
	console.log('ClassMate extension is now active.');

	void promptToEnableCodeLens(context);

	const chatSession = ChatSession.getInstance();

	// Initialize the skill-based system prompt builder.
	const skillDir = vscode.Uri.joinPath(context.extensionUri, 'skill', 'classmate');
	const loader = createSkillLoader();
	const promptBuilder = new SystemPromptBuilder(loader, skillDir);
	chatSession.setPromptBuilder(promptBuilder);

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
			handler: (...args: unknown[]) => {
				const selectedText = typeof args[0] === 'string' ? args[0] : undefined;
				const languageId = typeof args[1] === 'string' ? args[1] : undefined;
				createExplainSelectionHandler(
					chatSession,
					context.extensionUri,
					chatViewProvider,
					selectedText,
					languageId
				)();
			},
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

	// Register the classmate-output virtual document provider for compile/run output.
	registerCompileOutputProvider(context);

	// Register inline "Explain" button for source code editors (enabled languages only).
	registerInlineExplainButton(context, {
		selector: { scheme: 'file' },
		enabled: (document) => isLanguageEnabled(document.languageId),
		buildArgs: (_document, selectedText, _selection) => [
			typeof selectedText === 'string' ? selectedText : '',
			_document.languageId,
		],
	});

	// Register inline "Explain" button for the compile-output virtual document.
	registerInlineExplainButton(context, {
		selector: { scheme: COMPILE_OUTPUT_SCHEME },
		buildArgs: (document, selectedText, selection) => {
			// Use the full stderr line at the selection start so matching works
			// even when the user only selected part of the error message.
			const fullLine = document.lineAt(selection.start.line).text;
			return [fullLine || selectedText, COMPILE_OUTPUT_SCHEME];
		},
	});

	// Status bar: compile & run button (visible when the active file's language is enabled).
	const compileRunStatusBarItem = vscode.window.createStatusBarItem(
		vscode.StatusBarAlignment.Left,
		100
	);
	compileRunStatusBarItem.command = 'classmate.runCode';
	compileRunStatusBarItem.text = '$(run) ClassMate: Run';
	compileRunStatusBarItem.tooltip = 'Compile and run the current file';

	function updateCompileRunVisibility(): void {
		const editor = vscode.window.activeTextEditor;
		if (editor && isLanguageEnabled(editor.document.languageId)) {
			compileRunStatusBarItem.show();
		} else {
			compileRunStatusBarItem.hide();
		}
	}
	updateCompileRunVisibility();
	context.subscriptions.push(
		vscode.window.onDidChangeActiveTextEditor(() => updateCompileRunVisibility())
	);
	context.subscriptions.push(
		onEnabledLanguagesChanged(() => updateCompileRunVisibility())
	);
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
