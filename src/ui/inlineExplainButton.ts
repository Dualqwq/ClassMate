import * as vscode from 'vscode';

const EXPLAIN_TITLE = '$(lightbulb) Explain';

export interface InlineExplainOptions {
	/**
	 * Document selector that determines which editors this provider applies to.
	 */
	selector: vscode.DocumentSelector;

	/**
	 * Optional predicate to decide whether the button should be shown for a given
	 * document. The selection must also be non-empty.
	 */
	enabled?: (document: vscode.TextDocument) => boolean;

	/**
	 * Build the arguments passed to the `classmate.explainSelection` command when
	 * the button is clicked.
	 */
	buildArgs: (document: vscode.TextDocument, selectedText: string, selection: vscode.Selection) => unknown[];
}

/**
 * Register an inline "Explain" action that appears as a CodeLens above the
 * first line of the current selection.
 *
 * The provider is generic: callers supply a document selector, an optional
 * enablement predicate, and a function to build command arguments. This lets
 * the same module serve both source-code editors and the compile-output
 * virtual document.
 */
export function registerInlineExplainButton(
	context: vscode.ExtensionContext,
	options: InlineExplainOptions
): void {
	class ExplainCodeLensProvider implements vscode.CodeLensProvider {
		private readonly _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
		public readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

		public provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
			const editor = vscode.window.visibleTextEditors.find(
				(e) => e.document === document
			);
			if (!editor) {
				return [];
			}

			if (options.enabled && !options.enabled(document)) {
				return [];
			}

			const selection = editor.selection;
			if (!selection || selection.isEmpty) {
				return [];
			}

			const selectedText = document.getText(selection);
			const range = new vscode.Range(selection.start.line, 0, selection.start.line, 0);

			return [
				new vscode.CodeLens(range, {
					title: EXPLAIN_TITLE,
					command: 'classmate.explainSelection',
					arguments: options.buildArgs(document, selectedText, selection),
				}),
			];
		}

		public refresh(): void {
			this._onDidChangeCodeLenses.fire();
		}
	}

	const provider = new ExplainCodeLensProvider();

	context.subscriptions.push(
		vscode.languages.registerCodeLensProvider(options.selector, provider)
	);

	context.subscriptions.push(
		vscode.window.onDidChangeTextEditorSelection(() => {
			provider.refresh();
		})
	);

	context.subscriptions.push(
		vscode.window.onDidChangeActiveTextEditor(() => {
			provider.refresh();
		})
	);

	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration('classmate.enabledLanguages')) {
				provider.refresh();
			}
		})
	);
}
