import * as vscode from 'vscode';
import { isLanguageEnabled } from '../config/languageConfig';

const EXPLAIN_TITLE = '$(lightbulb) Explain';

/**
 * Register an inline "Explain" action that appears as a CodeLens above the
 * first line of the current selection.
 *
 * CodeLens is the only native VS Code API that satisfies all of these
 * constraints at once:
 * - renders in the gap between the previous line and the selected line
 * - does not shift the selected line horizontally or vertically
 * - is clickable without a hover tooltip
 * - disappears automatically when the selection is cleared
 *
 * True rounded-bubble styling is not available through any native inline
 * action API; the title is rendered using the editor's code-lens theme.
 */
export function registerInlineExplainButton(context: vscode.ExtensionContext): void {
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

            if (!isLanguageEnabled(document.languageId)) {
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
                    arguments: [selectedText, document.languageId],
                }),
            ];
        }

        public refresh(): void {
            this._onDidChangeCodeLenses.fire();
        }
    }

    const provider = new ExplainCodeLensProvider();

    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider({ scheme: 'file' }, provider)
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
