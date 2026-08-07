import { buildNotebookInput, buildNotebookPrompt, formatNotebookFallback } from './debug/debugNotebook';
import { DebugJourneyTreeProvider } from './ui/DebugJourneyTreeProvider';
import { registerDebugSnapshotProvider, getSnapshotUri, registerSnapshot } from './debug/debugSnapshotProvider';
import * as vscode from 'vscode';
import { spawnSync } from 'child_process';
import { ChatPanel, resolveRelocationTarget } from './ui/ChatPanel';
import { ChatViewProvider } from './ui/ChatViewProvider';
import { CHAT_CONTAINER_CONTEXT_KEY, nextChatContainer, toVisibleContainer, type ChatContainer } from './ui/chatContainer';
import { registerInlineExplainButton } from './ui/inlineExplainButton';
import { ChatSession } from './chat/ChatSession';
import type { ChatReference, LLMConfig, MessageIntent, PersistedChatData } from './chat/types';
import { chooseContainer } from './chat/MessageRouter';
import { setupApiKey, getApiKey } from './config/apiKey';
import { getLLMConfig, saveLLMConfig } from './config/llmConfig';
import { isLanguageEnabled, onEnabledLanguagesChanged } from './config/languageConfig';
import { checkGppAvailability, spawnGpp } from './compiler/compilerService';
import { registerCompileOutputProvider, showCompileOutput, COMPILE_OUTPUT_SCHEME, getCompileOutputContent } from './compiler/outputPanel';
import { extractErrorLocation, extractFirstDiagnosticLine, normalizeCompileOutputSelection } from './error/errorParser';
import type { CompileSelectionRange } from './error/errorParser';
import { matchErrorToKnowledge } from './error/errorKnowledgeMap';
import { createSkillLoader } from './prompts/promptLoader';
import { SystemPromptBuilder } from './prompts/systemPromptBuilder';
import { WorkspaceContextProvider } from './workspace/workspaceContextProvider';
import { DebugJourneyStore } from './debug/debugJourneyStore';
import { computeLineDiff } from './debug/diff';
import { getWorkspaceId } from './debug/storagePath';
import { ClaudeAdapter } from './llm/ClaudeAdapter';
import { OpenAIAdapter } from './llm/OpenAIAdapter';
import { DeepSeekAdapter } from './llm/DeepSeekAdapter';
import type { LLMAdapter } from './llm/types';
import { SkillContentLoader } from './skill/skillContentLoader';
import { SkillGraphLoader } from './skill/skillGraphLoader';
import { SkillSectionExtractor } from './skill/skillSectionExtractor';
import { ProblemCardExtractor } from './problemKnowledge/problemCardExtractor';
import { ProblemCardFactsLoader } from './problemKnowledge/problemCardFactsLoader';
import { ProblemCardIndexLoader } from './problemKnowledge/problemCardIndexLoader';
import { WorkspaceContextLoader } from './workspace/workspaceContextLoader';
import { AdapterGraphModelClient } from './graph/modelClient';
import type { GraphModelClient } from './graph/modelClient';
import type { LLMTokenUsage } from './llm/types';
import type {
    CodeModifiedEvent,
    CompileErrorEvent,
    CompileSuccessEvent,
    HintRequestedEvent,
} from './debug/types';

function createSessionId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Development-only API used by the paid live-evaluation harness.
 * It deliberately returns a configured model client instead of exposing the
 * plaintext API key. Production extension activation returns no such API.
 */
export interface ClassMateDevelopmentApi {
	createLiveEvalModel(
		onUsage: (usage: LLMTokenUsage, label?: string) => void
	): Promise<{
		provider: LLMConfig['provider'];
		model: string;
		client: GraphModelClient;
	}>;
}

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
		() => session.detach(provider),
		// WebviewView 隐藏后可能被销毁,再次 resolve 时重挂,恢复 streaming/stateSync 广播。
		() => session.attach(provider)
	);
	session.attach(provider);
	return provider;
}

function getContainerPreference(): 'auto' | 'view' | 'panel' {
	return vscode.workspace.getConfiguration('classmate').get('defaultContainer') ?? 'auto';
}

function findSymbolLine(document: vscode.TextDocument, symbol: string): number | undefined {
	const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const definition = new RegExp(
		`(?:^\\s*(?:struct|union|class|enum(?:\\s+class)?)\\s+${escaped}\\b)|(?:^\\s*(?:template\\s*<[^>]*>\\s*)?[A-Za-z_][\\w:<>*&\\[\\],\\s]*\\b${escaped}\\s*\\([^;{}]*\\)\\s*(?:\\{|;|$))`,
		'm'
	);
	const any = new RegExp(`\\b${escaped}\\b`);
	let firstOccurrence: number | undefined;
	for (let i = 0; i < document.lineCount; i++) {
		const text = document.lineAt(i).text;
		if (any.test(text)) {
			if (definition.test(text)) {
				return i; // 优先定义行
			}
			if (firstOccurrence === undefined) {
				firstOccurrence = i;
			}
		}
	}
	return firstOccurrence;
}

// Chat 容器当前状态(模块级单例;activate 在扩展生命周期内只调用一次)。
let currentContainer: ChatContainer = 'view';

function setChatContainer(container: ChatContainer): void {
	currentContainer = container;
	void vscode.commands.executeCommand('setContext', CHAT_CONTAINER_CONTEXT_KEY, container);
}

function showChatInContainer(
	session: ChatSession,
	extensionUri: vscode.Uri,
	chatViewProvider: ChatViewProvider,
	container: ChatContainer,
	options?: { preserveFocus?: boolean }
): void {
	setChatContainer(container);
	if (container === 'panel') {
		if (ChatPanel.hasCurrent()) {
			// Panel already exists; just reveal it without pulling the view back.
			ChatPanel.revealCurrent(options?.preserveFocus ?? false);
		} else {
			// 不 reveal chatView:panel 态下 package.json 的 when 子句会自动隐藏
			// ChatView,不需要"先弹 View 再延时关 sidebar"的 hack。
			createChatPanel(session, extensionUri, () => setChatContainer('view'), options);
		}
	} else if (container === 'view') {
		chatViewProvider.reveal(options?.preserveFocus ?? false);
	}
	// 'hidden':只更新 context,由 when 子句隐藏 ChatView;不创建/不聚焦任何容器。
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
	debugStore: DebugJourneyStore,
	sessionId: string,
	workspaceId: string,
	selectedText?: string,
	languageId?: string,
	selectionRange?: CompileSelectionRange
): () => void {
	return () => {
		const editor = vscode.window.activeTextEditor;
		const selection = editor?.selection;
		const text = selectedText ?? (selection && !selection.isEmpty
			? editor.document.getText(selection)
			: '');
		const lang = languageId ?? editor?.document.languageId ?? 'text';
		const fileUri = editor?.document.uri.toString();

		if (!text) {
			void vscode.window.showInformationMessage('Please select some code first.');
			return;
		}

		let intent: MessageIntent;
		let prompt: string;

		if (lang === COMPILE_OUTPUT_SCHEME) {
			intent = 'error_explanation';

			const normalized = normalizeCompileOutputSelection(text, getCompileOutputContent(), selectionRange);
			let parsed: ReturnType<typeof extractErrorLocation>;
			let displayText: string;

			if (normalized) {
				parsed = normalized.primaryDiagnostic;
				displayText = normalized.displayText;
			} else {
				const diagnosticLine = extractFirstDiagnosticLine(text);
				parsed = diagnosticLine ? extractErrorLocation(diagnosticLine) : undefined;
				displayText = text;
			}

			const knowledge = matchErrorToKnowledge(parsed?.message ?? text);
			const knowledgeText = knowledge.length > 0
				? knowledge.map((k) => `- ${k.tag}: ${k.message}`).join('\n')
				: 'No specific knowledge tag matched.';

			prompt = [
				'Explain this compile error in beginner-friendly language:',
				'',
				'Raw error:',
				'```',
				displayText,
				'```',
				parsed
					? `Location: ${parsed.file ?? 'unknown'}:${parsed.line ?? '?'}:${parsed.column ?? '?'}`
					: 'Location: could not parse',
				'',
				'Matched knowledge tags:',
				knowledgeText,
			].join('\n');
		} else {
			if (!isLanguageEnabled(lang)) {
				void vscode.window.showInformationMessage(
					`ClassMate is not enabled for language "${lang}". Add it to classmate.enabledLanguages in settings.`
				);
				return;
			}

			intent = 'code_explanation';
			prompt = `Explain this code:\n\n\`\`\`${lang}\n${text}\n\`\`\``;
		}

		const hintEvent: HintRequestedEvent = {
			id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
			type: 'hint_requested',
			timestamp: Date.now(),
			sessionId,
			workspaceId,
			fileUri,
			intent,
			userPrompt: prompt,
			selection: text,
		};

		if (intent === 'error_explanation') {
			void debugStore.getLastEvent({ workspaceId, fileUri, types: ['compile_error'] }).then((lastCompileError) => {
				if (lastCompileError) {
					hintEvent.relatedCompileEventId = lastCompileError.id;
				}
				void debugStore.append(hintEvent);
			});
		} else {
			void debugStore.append(hintEvent);
		}

		routeIntent(session, extensionUri, chatViewProvider, intent, prompt);
	};
}

async function compileHandlerAsync(
	debugStore: DebugJourneyStore,
	sessionId: string,
	workspaceId: string,
	lastKnownSource: Map<string, string>
): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	if (!editor || !isLanguageEnabled(editor.document.languageId)) {
		void vscode.window.showInformationMessage('ClassMate compile is not enabled for this file type.');
		return;
	}

	const document = editor.document;
	const fileUri = document.uri.toString();

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

	const relatedErrorId = await getLastCompileErrorEventId(debugStore, fileUri, workspaceId);
	await recordCodeModificationIfChanged(debugStore, sessionId, workspaceId, document, lastKnownSource, relatedErrorId);

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

		if (result.exitCode !== 0) {
			const parsedErrors = result.stderr
				.split('\n')
				.map((line) => extractErrorLocation(line))
				.filter((err): err is NonNullable<typeof err> => err !== undefined);

			const event: CompileErrorEvent = {
				id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
				type: 'compile_error',
				timestamp: Date.now(),
				sessionId,
				workspaceId,
				fileUri,
				stderr: result.stderr,
				parsedErrors,
				exitCode: result.exitCode,
				durationMs: result.durationMs,
			};
			await debugStore.append(event);
		} else {
			const event: CompileSuccessEvent = {
				id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
				type: 'compile_success',
				timestamp: Date.now(),
				sessionId,
				workspaceId,
				fileUri,
				exitCode: result.exitCode,
				durationMs: result.durationMs,
			};
			await debugStore.append(event);
		}
	} catch (error) {
		void vscode.window.showErrorMessage(`Compilation failed: ${String(error)}`);
	}
}

async function recordCodeModificationIfChanged(
	debugStore: DebugJourneyStore,
	sessionId: string,
	workspaceId: string,
	document: vscode.TextDocument,
	lastKnownSource: Map<string, string>,
	relatedEventId?: string
): Promise<void> {
	const fileUri = document.uri.toString();
	const currentText = document.getText();
	const previousText = lastKnownSource.get(fileUri);

	if (previousText !== undefined && previousText !== currentText) {
		const event: CodeModifiedEvent = {
			id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
			type: 'code_modified',
			timestamp: Date.now(),
			sessionId,
			workspaceId,
			fileUri,
			before: previousText,
			after: currentText,
			diff: computeLineDiff(previousText, currentText),
			trigger: 'pre_compile',
			relatedEventId,
		};
		await debugStore.append(event);
	}

	lastKnownSource.set(fileUri, currentText);
}

async function getLastCompileErrorEventId(
	debugStore: DebugJourneyStore,
	fileUri: string,
	workspaceId: string
): Promise<string | undefined> {
	const last = await debugStore.getLastEvent({ workspaceId, fileUri, types: ['compile_error'] });
	return last?.id;
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

async function runCodeHandlerAsync(
	debugStore: DebugJourneyStore,
	sessionId: string,
	workspaceId: string,
	lastKnownSource: Map<string, string>
): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	if (!editor || !isLanguageEnabled(editor.document.languageId)) {
		void vscode.window.showInformationMessage('ClassMate compile & run is not enabled for this file type.');
		return;
	}

	const document = editor.document;
	const fileUri = document.uri.toString();

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

	const relatedErrorId = await getLastCompileErrorEventId(debugStore, fileUri, workspaceId);
	await recordCodeModificationIfChanged(debugStore, sessionId, workspaceId, document, lastKnownSource, relatedErrorId);

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

			const parsedErrors = compileResult.stderr
				.split('\n')
				.map((line) => extractErrorLocation(line))
				.filter((err): err is NonNullable<typeof err> => err !== undefined);

			const event: CompileErrorEvent = {
				id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
				type: 'compile_error',
				timestamp: Date.now(),
				sessionId,
				workspaceId,
				fileUri,
				stderr: compileResult.stderr,
				parsedErrors,
				exitCode: compileResult.exitCode,
				durationMs: compileResult.durationMs,
			};
			await debugStore.append(event);
			return;
		}

		const successEvent: CompileSuccessEvent = {
			id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
			type: 'compile_success',
			timestamp: Date.now(),
			sessionId,
			workspaceId,
			fileUri,
			exitCode: compileResult.exitCode,
			durationMs: compileResult.durationMs,
		};
		await debugStore.append(successEvent);

		// Compilation succeeded: run the executable in an interactive terminal.
		runInTerminal(compileResult.outputPath);
	} catch (error) {
		void vscode.window.showErrorMessage(`Compile & run failed: ${String(error)}`);
	}
}

function compileHandler(debugStore: DebugJourneyStore, sessionId: string, workspaceId: string, lastKnownSource: Map<string, string>): () => void {
	return () => void compileHandlerAsync(debugStore, sessionId, workspaceId, lastKnownSource);
}

function runCodeHandler(debugStore: DebugJourneyStore, sessionId: string, workspaceId: string, lastKnownSource: Map<string, string>): () => void {
	return () => void runCodeHandlerAsync(debugStore, sessionId, workspaceId, lastKnownSource);
}

function explainSelectionHandler(): void {
	void vscode.window.showInformationMessage('ClassMate explain selection will run here.');
}

function explainErrorHandler(
	session: ChatSession,
	extensionUri: vscode.Uri,
	chatViewProvider: ChatViewProvider,
	debugStore: DebugJourneyStore,
	sessionId: string,
	workspaceId: string
): () => void {
	return () => {
		const editor = vscode.window.activeTextEditor;
		const fileUri = editor?.document.uri.toString();
		const prompt = '/error_explanation';

		const hintEvent: HintRequestedEvent = {
			id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
			type: 'hint_requested',
			timestamp: Date.now(),
			sessionId,
			workspaceId,
			fileUri,
			intent: 'error_explanation',
			userPrompt: prompt,
		};

		void debugStore.append(hintEvent);
		routeIntent(session, extensionUri, chatViewProvider, 'error_explanation', prompt);
	};
}

function findDebugNodeById(
	provider: DebugJourneyTreeProvider,
	eventId: string
): import('./debug/debugJourneyTreeNodes').DebugJourneyNode | undefined {
	function search(nodes: import('./debug/debugJourneyTreeNodes').DebugJourneyNode[]): import('./debug/debugJourneyTreeNodes').DebugJourneyNode | undefined {
		for (const node of nodes) {
			if (node.eventId === eventId) {
				return node;
			}
			const found = search(node.children);
			if (found) {
				return found;
			}
		}
		return undefined;
	}
	return search(provider.getRootNodes());
}

function createLLMAdapter(cfg: LLMConfig, apiKey: string | undefined): LLMAdapter | undefined {
	const key = apiKey || '';
	const baseURL = cfg.apiUrl || undefined;
	switch (cfg.provider) {
		case 'claude':
			return new ClaudeAdapter({ apiKey: key, model: cfg.model, baseURL });
		case 'openai':
			return new OpenAIAdapter({ apiKey: key, model: cfg.model, baseURL });
		case 'deepseek':
			return new DeepSeekAdapter({ apiKey: key, model: cfg.model, baseURL });
		default:
			return undefined;
	}
}

interface CompletionOutcome {
	content: string;
	usage?: import('./llm/types').LLMTokenUsage;
}

async function completeWithAdapter(adapter: LLMAdapter, req: import('./llm/types').LLMRequest): Promise<CompletionOutcome> {
	if (adapter.complete) {
		return adapter.complete(req);
	}

	return new Promise((resolve, reject) => {
		let content = '';
		let usage: import('./llm/types').LLMTokenUsage | undefined;
		adapter.streamResponse(adapter.buildRequest(req), {
			onToken: (token) => {
				content += token;
			},
			onError: (error) => reject(error),
			onUsage: (reportedUsage) => { usage = reportedUsage; },
			onComplete: () => resolve({ content, usage }),
		});
	});
}

async function exportDebugNotebookHandler(
	context: vscode.ExtensionContext,
	debugStore: DebugJourneyStore
): Promise<void> {
	const input = await buildNotebookInput(debugStore);
	const prompt = buildNotebookPrompt(input);

	let markdown: string;
	let actualUsage: import('./llm/types').LLMTokenUsage | undefined;
	const cfg = await getLLMConfig(context);
	const apiKey = await getApiKey(context);

	if (cfg && apiKey) {
		const adapter = createLLMAdapter(cfg, apiKey);
		if (adapter) {
			const progressMessage = `正在生成 Debug 错题本...`;
			const result = await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: progressMessage, cancellable: false },
				async () => {
					try {
						return await completeWithAdapter(adapter, { messages: prompt.messages });
					} catch (error) {
						void vscode.window.showWarningMessage(
							`LLM 生成失败，将使用模板导出：${error instanceof Error ? error.message : String(error)}`
						);
						return { content: formatNotebookFallback(input) };
					}
				}
			);
			markdown = result.content;
			actualUsage = result.usage;
		} else {
			void vscode.window.showInformationMessage('未识别 LLM 提供商，将使用模板导出错题本。');
			markdown = formatNotebookFallback(input);
		}
	} else {
		void vscode.window.showInformationMessage('未配置 API key，将使用模板导出错题本。');
		markdown = formatNotebookFallback(input);
	}

	if (!markdown.trim()) {
		markdown = formatNotebookFallback(input);
	}

	const dateSuffix = new Date().toISOString().slice(0, 10).replace(/-/g, '');
	const defaultUri = vscode.Uri.file(`classmate-debug-notebook-${debugStore.workspaceId}-${dateSuffix}.md`);

	const saveUri = await vscode.window.showSaveDialog({
		defaultUri,
		filters: { Markdown: ['md'] },
		saveLabel: 'Export Notebook',
	});

	if (!saveUri) {
		return;
	}

	await vscode.workspace.fs.writeFile(saveUri, Buffer.from(markdown, 'utf-8'));

	const usageMessage = actualUsage
		? `Debug 错题本已导出。本次实际消耗：${actualUsage.inputTokens} input / ${actualUsage.outputTokens} output tokens。`
		: 'Debug 错题本已导出。';
	void vscode.window.showInformationMessage(usageMessage);

	await vscode.window.showTextDocument(saveUri);
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

export function activate(
	context: vscode.ExtensionContext
): ClassMateDevelopmentApi | undefined {
	console.log('ClassMate extension is now active.');

	void promptToEnableCodeLens(context);

	const chatSession = ChatSession.getInstance();
	const performanceOutput = vscode.window.createOutputChannel('ClassMate Performance');
	context.subscriptions.push(performanceOutput);
	chatSession.setPerformanceTraceSink((event, data) => {
		performanceOutput.appendLine(JSON.stringify({
			timestamp: new Date().toISOString(),
			event,
			data,
		}));
	});

	// Initialize the debug journey store and session identifiers.
	const sessionId = createSessionId();
	const workspaceId = getWorkspaceId();
	const debugStore = new DebugJourneyStore(context, workspaceId);
	chatSession.setDebugStore(debugStore, sessionId, workspaceId);

	// Track the last known source text per file to detect meaningful edits.
	const lastKnownSource = new Map<string, string>();

	// Initialize the workspace context provider and load project context.
	const workspaceProvider = new WorkspaceContextProvider();
	void workspaceProvider.refresh();

	const chatStorageKey = `classmate.chatConversations.${workspaceId}`;
	chatSession.configurePersistence(
		context.workspaceState.get<PersistedChatData>(chatStorageKey),
		(data) => context.workspaceState.update(chatStorageKey, data)
	);
	chatSession.setReferenceHandlers(
		() => {
			const editor = workspaceProvider.getContext().activeEditor;
			if (!editor) {
				return [];
			}
			return [{
				label: editor.fileName.split(/[\\/]/).pop() ?? editor.fileName,
				uri: editor.uri,
				startLine: editor.selectionStartLine,
				endLine: editor.selectionEndLine,
			}];
		},
		async (reference: ChatReference) => {
			try {
				const document = await vscode.workspace.openTextDocument(
					vscode.Uri.parse(reference.uri)
				);
				const lastLine = Math.max(0, document.lineCount - 1);
				let startLine = Math.min(lastLine, Math.max(0, (reference.startLine ?? 1) - 1));
				// 只有符号没有行号时,按符号名词边界定位首次出现位置。
				if (reference.symbol && reference.startLine === undefined) {
					startLine = findSymbolLine(document, reference.symbol) ?? startLine;
				}
				const endLine = Math.min(
					lastLine,
					Math.max(startLine, (reference.endLine ?? reference.startLine ?? 1) - 1)
				);
				const selection = new vscode.Range(
					startLine,
					0,
					endLine,
					document.lineAt(endLine).text.length
				);
				// 面板 active 时直开对侧列:避免文件先落进面板组触发 relocation
				// (闪一下 + 重开时丢失 selection)。
				const panelColumn = ChatPanel.getActivePanelColumn();
				await vscode.window.showTextDocument(
					document,
					panelColumn !== undefined
						? { viewColumn: resolveRelocationTarget(panelColumn), selection }
						: { selection }
				);
			} catch {
				void vscode.window.showWarningMessage('引用的文件已不存在。');
			}
		}
	);

	// Initialize the skill-based system prompt builder.
	const skillDir = vscode.Uri.joinPath(context.extensionUri, 'skill', 'classmate');
	const loader = createSkillLoader();
	const promptBuilder = new SystemPromptBuilder(loader, skillDir, workspaceProvider);
	chatSession.setPromptBuilder(promptBuilder);
	const skillContentLoader = new SkillContentLoader(skillDir);
	const problemCardIndexLoader = new ProblemCardIndexLoader(skillContentLoader);
	chatSession.setGraphServices({
		workspaceProvider,
		workspaceLoader: new WorkspaceContextLoader(),
		skillContentLoader,
		skillGraphLoader: new SkillGraphLoader(skillContentLoader),
		skillSectionExtractor: new SkillSectionExtractor(skillContentLoader),
		problemCardIndexLoader,
		problemCardExtractor: new ProblemCardExtractor(skillContentLoader),
		problemCardFactsLoader: new ProblemCardFactsLoader(skillContentLoader),
	});

	// Register the sidebar WebviewView provider.
	const chatViewProvider = createChatViewProvider(chatSession, context.extensionUri);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chatViewProvider)
	);

	// Register the Debug Journey tree view and snapshot provider.
	registerDebugSnapshotProvider(context);
	const debugJourneyProvider = new DebugJourneyTreeProvider(debugStore);
	const debugJourneyTreeView = vscode.window.createTreeView(DebugJourneyTreeProvider.viewType, {
		treeDataProvider: debugJourneyProvider,
		showCollapseAll: true,
	});
	context.subscriptions.push(debugJourneyTreeView);

	// The Debug Journey view lives below ChatView in the same sidebar, collapsed
	// by default. It loads data eagerly but only takes space once the user expands
	// a node, so it stays out of the way until needed.
	void vscode.commands.executeCommand('setContext', 'classmate.debugJourneyTree.enabled', true);

	// Track which container a message is currently targeting.
	// 同步初始 context,让 package.json 的 when 子句在启动时即生效。
	setChatContainer('view');

	// Route assistant message intents to the appropriate container.
	chatSession.setOnIntent((intent) => {
		const target = chooseContainer(intent, getContainerPreference(), toVisibleContainer(currentContainer));
		if (target !== currentContainer) {
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
			handler: () => showChatInContainer(chatSession, context.extensionUri, chatViewProvider, toVisibleContainer(currentContainer)),
		},
		{
			id: 'classmate.openChatPanel',
			handler: () => showChatInContainer(chatSession, context.extensionUri, chatViewProvider, 'panel'),
		},
		{
			id: 'classmate.focusChatView',
			handler: () => {
				ChatPanel.closeCurrent();
				showChatInContainer(chatSession, context.extensionUri, chatViewProvider, 'view');
			},
		},
		{
			id: 'classmate.hideChatView',
			handler: () => {
				ChatPanel.closeCurrent(true);
				setChatContainer('hidden');
			},
		},
		{
			id: 'classmate.toggleChatContainer',
			handler: () => showChatInContainer(chatSession, context.extensionUri, chatViewProvider, nextChatContainer(currentContainer)),
		},
		{ id: 'classmate.compile', handler: compileHandler(debugStore, sessionId, workspaceId, lastKnownSource) },
		{ id: 'classmate.runCode', handler: runCodeHandler(debugStore, sessionId, workspaceId, lastKnownSource) },
		{
			id: 'classmate.explainSelection',
			handler: (...args: unknown[]) => {
				const selectedText = typeof args[0] === 'string' ? args[0] : undefined;
				const languageId = typeof args[1] === 'string' ? args[1] : undefined;
				const selectionRange = isCompileSelectionRange(args[2]) ? args[2] : undefined;
				createExplainSelectionHandler(
					chatSession,
					context.extensionUri,
					chatViewProvider,
					debugStore,
					sessionId,
					workspaceId,
					selectedText,
					languageId,
					selectionRange
				)();
			},
		},
		{
			id: 'classmate.explainError',
			handler: explainErrorHandler(
				chatSession,
				context.extensionUri,
				chatViewProvider,
				debugStore,
				sessionId,
				workspaceId
			),
		},
		{
			id: 'classmate.debugJourney',
			handler: async () => {
				await debugJourneyProvider.load();
				// 重新显示 Debug Journey 视图(closeDebugJourneyTree 会关掉 enabled context)。
				await vscode.commands.executeCommand('setContext', 'classmate.debugJourneyTree.enabled', true);
				await vscode.commands.executeCommand(`${DebugJourneyTreeProvider.viewType}.focus`);
			},
		},
		{
			id: 'classmate.refreshDebugJourneyTree',
			handler: () => debugJourneyProvider.refresh(),
		},
		{
			id: 'classmate.closeDebugJourneyTree',
			handler: async () => {
				// 只隐藏 Debug Journey 视图,不影响 ChatView,也不动 sidebar 物理开关。
				await vscode.commands.executeCommand('setContext', 'classmate.debugJourneyTree.enabled', false);
			},
		},
		{
			id: 'classmate.openDebugNodeDiff',
			handler: (...args: unknown[]) => {
				const eventId = typeof args[0] === 'string' ? args[0] : undefined;
				const fileUri = typeof args[1] === 'string' ? args[1] : undefined;
				if (!eventId) {
					return;
				}
				const node = findDebugNodeById(debugJourneyProvider, eventId);
				if (!node || !node.snapshot) {
					void vscode.window.showWarningMessage('No diff snapshot available for this node.');
					return;
				}
				registerSnapshot(eventId, node.snapshot.before, node.snapshot.after);
				const beforeUri = getSnapshotUri(eventId, 'before');
				const afterUri = getSnapshotUri(eventId, 'after');
				const title = fileUri
					? `${fileUri.split(/[\\/]/).pop() ?? fileUri} (edit)`
					: 'Code edit';
				void vscode.commands.executeCommand('vscode.diff', beforeUri, afterUri, title);
			},
		},
		{
			id: 'classmate.exportDebugNotebook',
			handler: () => void exportDebugNotebookHandler(context, debugStore),
		},
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
		buildArgs: (_document, selectedText, selection) => {
			// Pass the full selection plus a range hint so the handler can recover
			// incomplete lines (e.g., partial single-line selections) using the full
			// compile output, while still showing the user's exact selection to the LLM.
			const range: CompileSelectionRange = {
				startLine: selection.start.line,
				startCharacter: selection.start.character,
				endLine: selection.end.line,
				endCharacter: selection.end.character,
			};
			return [selectedText, COMPILE_OUTPUT_SCHEME, range];
		},
	});

	function isCompileSelectionRange(value: unknown): value is CompileSelectionRange {
		if (typeof value !== 'object' || value === null) {
			return false;
		}
		const r = value as Record<string, unknown>;
		return (
			typeof r.startLine === 'number' &&
			typeof r.startCharacter === 'number' &&
			typeof r.endLine === 'number' &&
			typeof r.endCharacter === 'number'
		);
	}

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

	if (context.extensionMode !== vscode.ExtensionMode.Production) {
		return {
			createLiveEvalModel: async (onUsage) => {
				const storedConfig = await getLLMConfig(context);
				const providerOverride = process.env.CLASSMATE_LIVE_EVAL_PROVIDER;
				const config: LLMConfig = {
					...storedConfig,
					provider: providerOverride === 'claude'
						|| providerOverride === 'openai'
						|| providerOverride === 'deepseek'
						? providerOverride
						: storedConfig.provider,
					model: process.env.CLASSMATE_LIVE_EVAL_MODEL
						?? storedConfig.model,
					apiUrl: process.env.CLASSMATE_LIVE_EVAL_API_URL
						?? storedConfig.apiUrl,
				};
				// 真实评测使用本次进程临时传入的密钥，避免测试用户目录中的旧密钥覆盖本次输入。
				// 正常安装版不会设置该环境变量，仍然只读取 VS Code SecretStorage。
				const apiKey = process.env.CLASSMATE_LIVE_EVAL_API_KEY
					?? await getApiKey(context);
				if (!apiKey) {
					throw new Error('ClassMate API key is not configured in VS Code SecretStorage.');
				}
				const adapter = createLLMAdapter(config, apiKey);
				if (!adapter) {
					throw new Error(`Unsupported ClassMate provider: ${config.provider}`);
				}
				return {
					provider: config.provider,
					model: config.model,
					client: new AdapterGraphModelClient(adapter, config.model, onUsage),
				};
			},
		};
	}
	return undefined;
}

export function deactivate(): void {
	console.log('ClassMate extension is deactivated.');
}
