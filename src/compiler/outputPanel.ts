import * as vscode from 'vscode';

export const COMPILE_OUTPUT_SCHEME = 'classmate-output';
export const COMPILE_OUTPUT_URI = vscode.Uri.parse(`${COMPILE_OUTPUT_SCHEME}:///compile-result.txt`);
export const MAKE_SETUP_GUIDE_URI = vscode.Uri.parse(`${COMPILE_OUTPUT_SCHEME}:///make-setup-guide.md`);

/**
 * Provides the content for the read-only compile output virtual document.
 * Exported so unit tests can drive the content/change-notification cycle
 * directly without a full extension activation.
 */
export class CompileOutputProvider implements vscode.TextDocumentContentProvider {
    private readonly _content = new Map<string, string>();
    private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
    public readonly onDidChange = this._onDidChange.event;

    public set(uri: vscode.Uri, content: string): void {
        this._content.set(uri.toString(), content);
        this._onDidChange.fire(uri);
    }

    public getLine(uri: vscode.Uri, lineNumber: number): string {
        const content = this._content.get(uri.toString()) ?? '';
        const lines = content.split(/\r?\n/);
        return lines[lineNumber] ?? '';
    }

    public getContent(uri: vscode.Uri): string {
        return this._content.get(uri.toString()) ?? '';
    }

    public provideTextDocumentContent(uri: vscode.Uri): string {
        return this._content.get(uri.toString()) ?? '';
    }
}

let _provider: CompileOutputProvider | undefined;

/**
 * Register the classmate-output content provider. Must be called once during
 * extension activation.
 */
export function registerCompileOutputProvider(context: vscode.ExtensionContext): void {
    _provider = new CompileOutputProvider();
    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider(COMPILE_OUTPUT_SCHEME, _provider)
    );
}

function getProvider(): CompileOutputProvider {
    if (!_provider) {
        throw new Error('CompileOutputProvider has not been registered.');
    }
    return _provider;
}

/**
 * Get a specific line from the current compile output document.
 */
export function getCompileOutputLine(lineNumber: number): string {
    const provider = getProvider();
    return provider.getLine(COMPILE_OUTPUT_URI, lineNumber);
}
/**
 * Get the full content of the current compile output document.
 */
export function getCompileOutputContent(): string {
    const provider = getProvider();
    return provider.getContent(COMPILE_OUTPUT_URI);
}

export async function showCompileOutput(content: string): Promise<void> {
    const provider = getProvider();
    provider.set(COMPILE_OUTPUT_URI, content);

    const activeEditor = vscode.window.activeTextEditor;
    const hasSplitView = vscode.window.visibleTextEditors.length > 1;
    const column = activeEditor?.viewColumn ?? vscode.ViewColumn.One;

    // If there is already a split view, open in the next column; otherwise
    // split to ViewColumn.Two so we don't replace the active editor.
    const targetColumn = hasSplitView
        ? (column === vscode.ViewColumn.One ? vscode.ViewColumn.Two : vscode.ViewColumn.Three)
        : vscode.ViewColumn.Two;

    const document = await vscode.workspace.openTextDocument(COMPILE_OUTPUT_URI);
    await vscode.window.showTextDocument(document, {
        viewColumn: targetColumn,
        preserveFocus: false,
        preview: false,
    });
}

/**
 * Open the bundled make setup guide as a read-only virtual document.
 * Used when the workspace has a root Makefile but no make executable
 * could be found on PATH.
 */
export async function showMakeSetupGuide(content: string): Promise<void> {
    const provider = getProvider();
    provider.set(MAKE_SETUP_GUIDE_URI, content);

    const document = await vscode.workspace.openTextDocument(MAKE_SETUP_GUIDE_URI);
    await vscode.window.showTextDocument(document, {
        viewColumn: vscode.ViewColumn.Two,
        preserveFocus: false,
        preview: false,
    });
}
