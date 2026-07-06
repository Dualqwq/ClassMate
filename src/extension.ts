import * as vscode from 'vscode';
import { ChatPanel } from './ui/ChatPanel';

// Placeholder command handlers. These will be replaced by real implementations
// in later tasks as the codebase grows under src/commands and src/ui.
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

function setupApiKeyHandler(): void {
	void vscode.window.showInformationMessage('ClassMate API key setup will run here.');
}

export function activate(context: vscode.ExtensionContext): void {
	console.log('ClassMate extension is now active.');

	// Register all commands declared in package.json.
	const commands: { id: string; handler: (...args: unknown[]) => void }[] = [
		{ id: 'classmate.openChat', handler: () => ChatPanel.createOrShow(context.extensionUri) },
		{ id: 'classmate.compile', handler: compileHandler },
		{ id: 'classmate.runCode', handler: runCodeHandler },
		{ id: 'classmate.explainSelection', handler: explainSelectionHandler },
		{ id: 'classmate.explainError', handler: explainErrorHandler },
		{ id: 'classmate.debugJourney', handler: debugJourneyHandler },
		{ id: 'classmate.setupApiKey', handler: setupApiKeyHandler },
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
	chatStatusBarItem.tooltip = 'Open ClassMate chat panel';
	chatStatusBarItem.show();
	context.subscriptions.push(chatStatusBarItem);
}

export function deactivate(): void {
	console.log('ClassMate extension is deactivated.');
}
