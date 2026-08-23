import { buildNotebookInput, buildNotebookPrompt, formatNotebookFallback } from './debug/debugNotebook';
import { DebugJourneyTreeProvider } from './ui/DebugJourneyTreeProvider';
import { registerDebugSnapshotProvider, getSnapshotUri, registerSnapshot } from './debug/debugSnapshotProvider';
import * as vscode from 'vscode';
import { spawnSync } from 'child_process';
import * as path from 'path';
import { ChatPanel } from './ui/ChatPanel';
import { RunPanel } from './ui/RunPanel';
import { CoursewarePanel } from './ui/CoursewarePanel';
import { RunService } from './run/runService';
import { CoursewareService } from './courseware/coursewareService';
import { ChatViewProvider } from './ui/ChatViewProvider';
import { CHAT_CONTAINER_CONTEXT_KEY, nextChatContainer, toVisibleContainer, type ChatContainer } from './ui/chatContainer';
import { showTextDocumentRespectingPanels } from './ui/panelGrouping';
import { registerInlineExplainButton } from './ui/inlineExplainButton';
import { ChatSession } from './chat/ChatSession';
import { ChatSessionStorage } from './chat/chatSessionStorage';
import type { ChatReference, LLMConfig, MessageIntent } from './chat/types';
import { ConversationDiagnosticRecorder } from './chat/conversationDiagnostics';
import { chooseContainer } from './chat/MessageRouter';
import { getApiKey } from './config/apiKey';
import { getLLMConfig, saveLLMConfig, getFallbackLLMConfig, saveFallbackLLMConfig, getFallbackApiKey } from './config/llmConfig';
import { createLocalSettingsServer, getThemeSettings } from './settings/localSettingsServer';
import { openLocalSettingsPage } from './settings/localSettings';
import { isLanguageEnabled, onEnabledLanguagesChanged } from './config/languageConfig';
import { checkGppAvailability, detectMakeTool, findRootMakefile, isCompilableSourceFile, previewGppCommand, spawnGpp, spawnMake } from './compiler/compilerService';
import { registerCompileOutputProvider, showCompileOutput, showMakeSetupGuide, buildCompileStartInfo, buildNoCompilableSourceGuidance, updateCompileOutput, COMPILE_OUTPUT_SCHEME, getCompileOutputContent } from './compiler/outputPanel';
import { extractErrorLocation, extractFirstDiagnosticLine, normalizeCompileOutputSelection } from './error/errorParser';
import type { CompileSelectionRange } from './error/errorParser';
import { matchErrorToKnowledge } from './error/errorKnowledgeMap';
import { createSkillLoader } from './prompts/promptLoader';
import { SystemPromptBuilder } from './prompts/systemPromptBuilder';
import { WorkspaceContextProvider } from './workspace/workspaceContextProvider';
import { ActivationProfiler, getActivationProfile, isActivationProfilingEnabled } from './activationProfiler';
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
import { startBrowserExtensionImportServer } from './browserExtensionImport/server';
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
	getActivationProfile(): import('./activationProfiler').ActivationProfile | undefined;
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
		{
			...options,
			onDidClose,
			// active 是 compile_result.txt(classmate-output: 虚拟文档)时,
			// 面板与它同分组打开(它同为 ClassMate 面板面,不当源码编辑器避让)。
			activeEditorIsClassMateOutput:
				vscode.window.activeTextEditor?.document.uri.scheme === COMPILE_OUTPUT_SCHEME,
		}
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
	lastKnownSource: Map<string, string>,
	extensionUri: vscode.Uri
): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	if (!editor || !isLanguageEnabled(editor.document.languageId)) {
		// 兜底(G4 拍板):无 active 编辑器或当前文件不是 C/C++,不编译,
		// compile_result.txt 给出明确引导。
		await showCompileOutput(buildNoCompilableSourceGuidance(
			editor
				? `当前打开的文件不是 C/C++ 源文件: ${editor.document.fileName}`
				: '当前没有打开任何文件。'
		));
		return;
	}

	const document = editor.document;
	const fileUri = document.uri.toString();

	if (document.isDirty && !(await document.save())) {
		void vscode.window.showWarningMessage('Could not save the current file before compiling.');
		return;
	}

	// #8: 工作区根目录有 Makefile(大小写不敏感,只认根目录)时改用 make 构建。
	const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
	if (workspaceFolder) {
		const workspaceRoot = workspaceFolder.uri.fsPath;
		const rootMakefile = await findRootMakefile(workspaceRoot);
		if (rootMakefile) {
			const relatedErrorId = await getLastCompileErrorEventId(debugStore, fileUri, workspaceId);
			await recordCodeModificationIfChanged(debugStore, sessionId, workspaceId, document, lastKnownSource, relatedErrorId);
			await compileWithMakeAsync(debugStore, sessionId, workspaceId, fileUri, workspaceRoot, rootMakefile, extensionUri);
			return;
		}

		// Makefile 只在子目录时不递归兼容:提示用户放根目录,然后继续走 g++ 单文件。
		const fileDir = path.dirname(document.fileName);
		if (path.resolve(fileDir) !== path.resolve(workspaceRoot) && (await findRootMakefile(fileDir))) {
			void vscode.window.showInformationMessage(
				'ClassMate 只使用工作区根目录的 Makefile;检测到 Makefile 在子目录中,本次仍按 g++ 单文件编译。请把 Makefile 放到工作区根目录,或把该子目录作为工作区打开。'
			);
		}
	}

	// G4 拍板:无根目录 Makefile 时 g++ 路径只编当前 active 源文件(教学场景聚焦
	// 当前文件);active 是头文件等非源文件时不编译,引导进 compile_result.txt。
	// 有根目录 Makefile 的 make 路径在上面已 return,不受此守卫影响。
	if (!isCompilableSourceFile(document.fileName)) {
		await showCompileOutput(buildNoCompilableSourceGuidance(
			`当前打开的不是可编译源文件: ${document.fileName}(头文件由 .c/.cpp 源文件包含,不需要单独编译)`
		));
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
		// #9 两阶段(与 make 路径一致):即时预创建 compile_result.txt 展示
		// 编译基本信息,编译结束后就地强刷为全量输出(不重新打开编辑器)。
		const preview = await previewGppCommand(document.fileName, { relatedSources: false });
		await showCompileOutput(buildCompileStartInfo('g++ 编译', [
			`编译器: ${preview.command}`,
			`源文件: ${preview.sourcePaths.join(', ')}`,
			`命令: ${preview.command} ${preview.args.join(' ')}`,
		]));

		const result = await spawnGpp(document.fileName, { relatedSources: false });
		const output = [
			`Compiled: ${document.fileName}`,
			`Command: ${preview.command} ${preview.args.join(' ')}`,
			`Exit code: ${result.exitCode ?? 'killed'}`,
			`Duration: ${result.durationMs}ms`,
			result.stdout ? `\n--- stdout ---\n${result.stdout}` : '',
			result.stderr ? `\n--- stderr ---\n${result.stderr}` : '',
		]
			.filter(Boolean)
			.join('\n');

		updateCompileOutput(output);
		await recordCompileOutcome(debugStore, sessionId, workspaceId, fileUri, result);
	} catch (error) {
		// spawn 级失败(超时/取消)也写回文档,不停留在"编译已开始"。
		updateCompileOutput(`Compilation failed: ${String(error)}`);
		void vscode.window.showErrorMessage(`Compilation failed: ${String(error)}`);
	}
}

/**
 * Record the outcome of a build (g++ or make) into the debug journey store.
 */
async function recordCompileOutcome(
	debugStore: DebugJourneyStore,
	sessionId: string,
	workspaceId: string,
	fileUri: string,
	result: { exitCode: number | null; stderr: string; durationMs: number }
): Promise<void> {
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
}

const MAKE_SETUP_GUIDE_FALLBACK = [
	'# 未找到 make',
	'',
	'ClassMate 检测到工作区根目录有 Makefile,但系统 PATH 中找不到 make 或 mingw32-make。',
	'Windows:安装 MinGW-w64 并把其 bin 目录(内含 mingw32-make.exe)加入 Path 后重启 VS Code。',
	'macOS:终端执行 xcode-select --install。Linux:安装 build-essential。',
].join('\n');

/**
 * #8/#9: 根目录 Makefile 场景的构建流程——点击后即时预创建 compile_result.txt
 * 展示基本信息,make 结束后强制刷新一次展示全量输出;make 缺失时打开随扩展
 * 打包的预置文案(只读虚拟文档),不报错。编译哪些代码完全由 Makefile 决定。
 */
async function compileWithMakeAsync(
	debugStore: DebugJourneyStore,
	sessionId: string,
	workspaceId: string,
	fileUri: string,
	workspaceRoot: string,
	makefilePath: string,
	extensionUri: vscode.Uri
): Promise<void> {
	const makeTool = detectMakeTool();
	if (!makeTool) {
		let guide = MAKE_SETUP_GUIDE_FALLBACK;
		try {
			const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(extensionUri, 'resources', 'make-setup-guide.md'));
			guide = Buffer.from(bytes).toString('utf8');
		} catch {
			// 打包资源缺失时退回内置简要文案,保证用户始终能看到指引。
		}
		await showMakeSetupGuide(guide);
		return;
	}

	await showCompileOutput(buildCompileStartInfo(`${makeTool} 构建`, [
		`构建工具: ${makeTool}(无参,使用 Makefile 默认 target)`,
		`遵循指令: ${makefilePath}`,
		`工作目录: ${workspaceRoot}`,
	]));

	try {
		const result = await spawnMake(makeTool, workspaceRoot);
		const output = [
			`Built with: ${makeTool} (default target)`,
			`Makefile: ${makefilePath}`,
			`Working directory: ${workspaceRoot}`,
			`Exit code: ${result.exitCode ?? 'killed'}`,
			`Duration: ${result.durationMs}ms`,
			result.stdout ? `\n--- stdout ---\n${result.stdout}` : '',
			result.stderr ? `\n--- stderr ---\n${result.stderr}` : '',
		]
			.filter(Boolean)
			.join('\n');

		// 强刷=就地更新同一虚拟文档;不再调 showTextDocument,避免开出第二个 compile_result.txt。
		updateCompileOutput(output);
		await recordCompileOutcome(debugStore, sessionId, workspaceId, fileUri, result);
	} catch (error) {
		// spawn 级失败(超时/取消)也写回文档,不停留在"编译已开始"。
		updateCompileOutput(`Make build failed: ${String(error)}`);
		void vscode.window.showErrorMessage(`Make build failed: ${String(error)}`);
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

function compileHandler(debugStore: DebugJourneyStore, sessionId: string, workspaceId: string, lastKnownSource: Map<string, string>, extensionUri: vscode.Uri): () => void {
	return () => void compileHandlerAsync(debugStore, sessionId, workspaceId, lastKnownSource, extensionUri);
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

export async function activate(
	context: vscode.ExtensionContext
): Promise<ClassMateDevelopmentApi | undefined> {
	console.log('ClassMate extension is now active.');

	const performanceOutput = vscode.window.createOutputChannel('ClassMate Performance');
	context.subscriptions.push(performanceOutput);
	const profiler = new ActivationProfiler(isActivationProfilingEnabled(context), performanceOutput);
	profiler.mark('output-channel-created');

	void promptToEnableCodeLens(context);
	profiler.mark('code-lens-prompt-fired');

	const chatSession = ChatSession.getInstance();
	// 开发态 extensionUri 指向 code/classmate,上一级是 code,上两级才是项目根(智理杯);
	// 调试输出固定落到 <项目根>/log,不随当前打开的工作区变化。
	chatSession.setDebugOutputDir(path.resolve(context.extensionUri.fsPath, '..', '..', 'log'));
	profiler.mark('chat-session-created');
	chatSession.setPerformanceTraceSink((event, data) => {
		performanceOutput.appendLine(JSON.stringify({
			timestamp: new Date().toISOString(),
			event,
			data,
		}));
	});
	profiler.mark('performance-sink-set');

	// Initialize the debug journey store and session identifiers.
	const sessionId = createSessionId();
	const workspaceId = getWorkspaceId();
	const debugStore = new DebugJourneyStore(context, workspaceId);
	chatSession.setDebugStore(debugStore, sessionId, workspaceId);
	const diagnosticRecorder = new ConversationDiagnosticRecorder(
		vscode.Uri.joinPath(
			context.globalStorageUri,
			'conversation-diagnostics',
			workspaceId,
			`${sessionId}.jsonl`
		).fsPath,
		{ sessionId, workspaceId }
	);
	chatSession.setDiagnosticRecorder(diagnosticRecorder, {
		extensionVersion: String(context.extension.packageJSON.version ?? 'unknown'),
		workspaceFolders: vscode.workspace.workspaceFolders?.map(
			(folder) => folder.uri.fsPath
		) ?? [],
	});
	profiler.mark('diagnostics-ready');

	// Track the last known source text per file to detect meaningful edits.
	const lastKnownSource = new Map<string, string>();

	// Initialize the workspace context provider and load project context.
	const workspaceProvider = new WorkspaceContextProvider();
	void workspaceProvider.refresh();
	profiler.mark('workspace-provider-ready');

	const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;
	const chatStorage = new ChatSessionStorage(
		context.globalStorageUri.fsPath,
		workspaceUri?.toString()
	);
	await chatStorage.migrateFromWorkspaceState(context.workspaceState, workspaceId);
	chatSession.configurePersistence(
		await chatStorage.load(),
		(data) => chatStorage.save(data)
	);
	profiler.mark('persistence-configured');
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
				// ADD2 统一分组逻辑(已泛化到任意 ClassMate 面板,见 ui/panelGrouping.ts):
				// active 标签不是 ClassMate 面板 → 目标文件在 active 组打开,原文件
				// 留在同组;是 ClassMate 面板 → 开到面板之外、已有文件的分组(没有
				// 则创建对侧分组),预路由一步到位,不经过面板组(#18 零闪屏路径)。
				// 目标以常驻(preview:false)方式打开:原文件若是预览 tab,会保留为
				// 后台预览而不被 VS Code 替换;目标文件成为 active。
				await showTextDocumentRespectingPanels(document, {
					selection,
					preview: false,
				});
			} catch {
				void vscode.window.showWarningMessage('引用的文件已不存在。');
			}
		}
	);
	profiler.mark('reference-handlers-set');

	// Initialize the skill-based system prompt builder.
	const skillDir = vscode.Uri.joinPath(context.extensionUri, 'skill', 'classmate');
	const loader = createSkillLoader();
	const promptBuilder = new SystemPromptBuilder(loader, skillDir, workspaceProvider);
	chatSession.setPromptBuilder(promptBuilder);
	const skillContentLoader = new SkillContentLoader(skillDir);
	const problemCardIndexLoader = new ProblemCardIndexLoader(skillContentLoader);
	const coursewareService = new CoursewareService(context);
	chatSession.setGraphServices({
		workspaceProvider,
		// Tree-sitter wasm 定位基准:VSIX/F5 布局下优先 dist/wasm。
		extensionPath: context.extensionPath,
		workspaceLoader: new WorkspaceContextLoader(),
		skillContentLoader,
		skillGraphLoader: new SkillGraphLoader(skillContentLoader),
		skillSectionExtractor: new SkillSectionExtractor(skillContentLoader),
		problemCardIndexLoader,
		problemCardExtractor: new ProblemCardExtractor(skillContentLoader),
		problemCardFactsLoader: new ProblemCardFactsLoader(skillContentLoader),
		coursewareService,
	});
	profiler.mark('graph-services-ready');

	// Register the sidebar WebviewView provider.
	const chatViewProvider = createChatViewProvider(chatSession, context.extensionUri);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chatViewProvider)
	);
	profiler.mark('chat-view-registered');

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
	profiler.mark('debug-journey-registered');

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

	// 7.8 恢复通道:显式配置的备用 provider。未配置时恢复通道只做图内重试,
	// 不存在隐式默认备用。
	void refreshFallbackLLMConfig();

	function refreshFallbackLLMConfig(): Promise<void> {
		return getFallbackLLMConfig(context).then((config) => {
			chatSession.setFallbackLLMConfig(
				config,
				config ? () => getFallbackApiKey(context) : undefined
			);
		});
	}

	// Save fallback LLM config from webview (undefined input = clear).
	chatSession.setOnSaveFallbackLLMConfig((input) => {
		void saveFallbackLLMConfig(context, input).then(() => refreshFallbackLLMConfig());
	});

	// Provide API key to ChatSession for LLM calls.
	chatSession.setOnGetApiKey(() => getApiKey(context));
	profiler.mark('llm-config-wired');

	// ADD5 本地设置页:启动 127.0.0.1 上的本地 HTTP server,token 存 SecretStorage。
	const localSettingsServer = await createLocalSettingsServer(context, {
		onThemeSaved: (theme) => chatSession.broadcastThemeUpdate(theme),
		onConfigSaved: (config) => {
			// 浏览器设置页保存后,运行中的 host 立即换用新 provider/model/url:
			// setLLMConfig 同时向 webview 广播 llmConfig;恢复通道配置同步刷新
			//(key 本体不在此处,LLM 调用时每次经 _onGetApiKey 读 SecretStorage)。
			chatSession.setLLMConfig(config);
			void refreshFallbackLLMConfig();
		},
	});
	context.subscriptions.push({
		dispose: () => {
			void localSettingsServer.close();
		},
	});

	chatSession.setOnOpenLocalSettings(() => {
		void openLocalSettingsPage(context, localSettingsServer.url);
	});

	chatSession.setOnRequestTheme(() => getThemeSettings(context));
	// 启动即把持久化主题 seed 为"当前主题":此后首个/每个面板 attach 时都会
	// 被补推,不依赖前端 requestTheme 的异步往返时序。
	void getThemeSettings(context).then((theme) => chatSession.broadcastThemeUpdate(theme));

	// Run 面板(#11):与 Chat Panel 同级的大标签页面板,共享 React bundle +
	// route 切换;只消费编译产物(compile_result.txt / 源文件推导),不做编译决策。
	const runService = new RunService(context);
	profiler.mark('run-service-created');

	// ADD6 浏览器扩展题目导入：启动本地 HTTP 端点(仅 127.0.0.1)。
	// 状态栏常驻项让"server 是否已监听、监听哪个端口"对用户一眼可见
	// (G5 二轮反馈的根因是扩展未激活时 server 根本不存在,浏览器侧无从自查)。
	const importStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
	importStatusItem.name = 'ClassMate 浏览器导入状态';
	importStatusItem.command = 'classmate.showBrowserExtensionImportStatus';
	context.subscriptions.push(importStatusItem);
	void startBrowserExtensionImportServer(context)
		.then(({ port, dispose }) => {
			context.subscriptions.push({ dispose });
			importStatusItem.text = `$(plug) ClassMate 导入:${port}`;
			importStatusItem.tooltip = `浏览器扩展导入端点 http://127.0.0.1:${port}/import\n点击查看详情`;
			importStatusItem.show();
			console.log(`ClassMate browser extension import server listening on port ${port}`);
		})
		.catch((error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			importStatusItem.text = '$(error) ClassMate 导入离线';
			importStatusItem.tooltip = `浏览器扩展导入服务启动失败：${message}`;
			importStatusItem.show();
			console.error('ClassMate browser extension import server failed to start:', message);
			void vscode.window.showWarningMessage(`ClassMate: 浏览器扩展导入服务启动失败：${message}`);
		});

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
			id: 'classmate.openLocalSettings',
			handler: () => openLocalSettingsPage(context, localSettingsServer.url),
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
		{ id: 'classmate.compile', handler: compileHandler(debugStore, sessionId, workspaceId, lastKnownSource, context.extensionUri) },
		{ id: 'classmate.runCode', handler: runCodeHandler(debugStore, sessionId, workspaceId, lastKnownSource) },
		{
			// #11:编辑器工具栏的 Run 图标改为打开/聚焦 Run 面板(执行按钮在面板内)。
			id: 'classmate.openRunPanel',
			handler: () => {
				RunPanel.createOrShow(context.extensionUri, runService);
			},
		},
		{
			id: 'classmate.openCoursewarePanel',
			handler: () => {
				CoursewarePanel.createOrShow(context.extensionUri, coursewareService);
			},
		},
		{
			id: 'classmate.exportCoursewareGraph',
			handler: async () => {
				const graph = await coursewareService.loadGraph();
				if (graph.nodes.length === 0) {
					void vscode.window.showWarningMessage(
						'尚未构建课件搜索图：请先在课件管理页导入课件并点击「重建搜索图」。'
					);
					return;
				}
				const defaultUri = vscode.workspace.workspaceFolders?.[0]
					? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, 'classmate-courseware-graph.json')
					: vscode.Uri.file('classmate-courseware-graph.json');
				const target = await vscode.window.showSaveDialog({
					title: '导出课件搜索图文件',
					defaultUri,
					filters: { JSON: ['json'] },
				});
				if (!target) {
					return;
				}
				await vscode.workspace.fs.writeFile(target, Buffer.from(JSON.stringify(graph, null, 2), 'utf8'));
				void vscode.window.showInformationMessage(
					`已导出课件搜索图（${graph.nodes.length} 节点 / ${graph.edges.length} 边）：${target.fsPath}`
				);
			},
		},
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
		{
			id: 'classmate.exportConversationDiagnostics',
			handler: async (...args: unknown[]) => {
				const outputPath = typeof args[0] === 'string' ? args[0] : undefined;
				const options = typeof args[1] === 'object' && args[1] !== null
					? args[1] as { reveal?: boolean }
					: undefined;
				try {
					return await chatSession.exportDiagnostics(outputPath, options);
				} catch (error) {
					void vscode.window.showErrorMessage(
						`ClassMate: 对话诊断导出失败：${error instanceof Error ? error.message : String(error)}`
					);
					throw error;
				}
			},
		},
		{
			// G5 复测:该命令的旧实现是原生 InputBox 密码框(简陋 UI),曾被误当
			// "模型设置"入口。收敛为明确提示 + 一键跳转本地网页设置页,不再弹
			// 原生输入框;模型配置(含 API Key)统一在设置页管理。
			id: 'classmate.setupApiKey',
			handler: async () => {
				const choice = await vscode.window.showInformationMessage(
					'ClassMate 的模型配置（含 API Key）请在本地设置页中管理。',
					'打开设置页'
				);
				if (choice === '打开设置页') {
					await openLocalSettingsPage(context, localSettingsServer.url);
				}
			},
		},
		{
			id: 'classmate.showBrowserExtensionImportStatus',
			handler: () => {
				const port = context.globalState.get<number>('classmate.browserExtension.importPort');
				if (port) {
					void vscode.window.showInformationMessage(
						`ClassMate 浏览器扩展导入服务运行在 http://127.0.0.1:${port}/import`
					);
				} else {
					void vscode.window.showWarningMessage('ClassMate 浏览器扩展导入服务尚未启动。');
				}
			},
		},
	];

	for (const { id, handler } of commands) {
		context.subscriptions.push(vscode.commands.registerCommand(id, handler));
	}
	profiler.mark('commands-registered');

	// Register the classmate-output virtual document provider for compile/run output.
	registerCompileOutputProvider(context);
	profiler.mark('compile-output-provider-registered');

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
	profiler.mark('inline-explain-registered');

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

	// Status bar: Run button opens the Run panel (#11 拍板:Run 为独立按钮,
	// 替代原 classmate.runCode 的 Compile & Run 入口;runCode 仍留命令面板)。
	const compileRunStatusBarItem = vscode.window.createStatusBarItem(
		vscode.StatusBarAlignment.Left,
		100
	);
	compileRunStatusBarItem.command = 'classmate.openRunPanel';
	compileRunStatusBarItem.text = '$(run) ClassMate: Run';
	compileRunStatusBarItem.tooltip = 'Open the ClassMate run panel';

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
	profiler.mark('status-bars-ready');
	profiler.finish();

	if (context.extensionMode !== vscode.ExtensionMode.Production) {
		return {
			getActivationProfile,
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
