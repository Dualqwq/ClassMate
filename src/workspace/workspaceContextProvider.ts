import * as vscode from 'vscode';
import type { WorkspaceContext, CourseContext, WorkspaceCodeChange, WorkspaceCodeDocument } from './types';
import { parseClassmateMd } from './classmateFileParser';
import * as path from 'path';
import { extractPdfUri, formatPdfExtraction } from './pdfExtractor';

const TEXT_EXTENSIONS = new Set(['.md', '.txt', '.markdown']);
const CODE_EXTENSIONS = new Set(['.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp', '.hxx']);

function isCodeFile(uri: vscode.Uri): boolean {
    return CODE_EXTENSIONS.has(path.extname(uri.fsPath).toLowerCase());
}

function isTextFile(uri: vscode.Uri): boolean {
    const ext = uri.path.slice(uri.path.lastIndexOf('.')).toLowerCase();
    return TEXT_EXTENSIONS.has(ext);
}

async function readFirstTextFile(uris: vscode.Uri[]): Promise<string | undefined> {
    for (const uri of uris) {
        if (!isTextFile(uri)) {
            continue;
        }
        try {
            const bytes = await vscode.workspace.fs.readFile(uri);
            return Buffer.from(bytes).toString('utf-8');
        } catch {
            // Ignore unreadable files and try the next one.
        }
    }
    return undefined;
}

function toRelativePath(uri: vscode.Uri): string {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) {
        return uri.fsPath;
    }
    return vscode.workspace.asRelativePath(uri, false);
}

function languageIdForCodeFile(uri: vscode.Uri): string {
    return path.extname(uri.fsPath).toLowerCase() === '.c' ? 'c' : 'cpp';
}

async function readCodeDocument(uri: vscode.Uri): Promise<WorkspaceCodeDocument | undefined> {
    const openDocument = vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString());
    try {
        const content = openDocument
            ? openDocument.getText()
            : Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf-8');
        return {
            fileName: toRelativePath(uri),
            languageId: openDocument?.languageId ?? languageIdForCodeFile(uri),
            content,
        };
    } catch {
        return undefined;
    }
}

export function selectQuestionFile(questionFiles: vscode.Uri[], activeFile?: vscode.Uri): vscode.Uri | undefined {
    if (questionFiles.length === 0) {
        return undefined;
    }
    const sorted = [...questionFiles].sort((a, b) => a.fsPath.localeCompare(b.fsPath));
    if (activeFile?.scheme === 'file') {
        const activeDir = path.dirname(activeFile.fsPath).toLowerCase();
        const sameDirectory = sorted.find((uri) => path.dirname(uri.fsPath).toLowerCase() === activeDir);
        if (sameDirectory) {
            return sameDirectory;
        }
    }
    return sorted[0];
}

export function selectProblemFile(
    markdownFiles: vscode.Uri[],
    pdfFiles: vscode.Uri[],
    activeFile?: vscode.Uri
): vscode.Uri | undefined {
    if (activeFile?.scheme === 'file') {
        const activeDir = path.dirname(activeFile.fsPath).toLowerCase();
        const sameDirectoryMarkdown = markdownFiles.find(
            (uri) => path.dirname(uri.fsPath).toLowerCase() === activeDir
        );
        if (sameDirectoryMarkdown) {
            return sameDirectoryMarkdown;
        }
        const sameDirectoryPdf = pdfFiles.find(
            (uri) => path.dirname(uri.fsPath).toLowerCase() === activeDir
        );
        if (sameDirectoryPdf) {
            return sameDirectoryPdf;
        }
    }
    return selectQuestionFile(markdownFiles, activeFile)
        ?? [...pdfFiles].sort((a, b) => a.fsPath.localeCompare(b.fsPath))[0];
}

/**
 * Scans the active workspace for project context:
 * - C/C++ source/header files
 * - the nearest question.md problem description
 * - CLASSMATE.md course configuration
 *
 * Watches CLASSMATE.md and question.md files for changes and exposes an
 * event so consumers can react to updated context.
 */
export class WorkspaceContextProvider {
    private readonly _onDidChange = new vscode.EventEmitter<void>();
    public readonly onDidChange = this._onDidChange.event;

    private _context: WorkspaceContext = {
        cppFiles: [],
        codeDocuments: [],
        codeChanges: [],
    };
    private readonly _codeChanges: WorkspaceCodeChange[] = [];
    /** Last real text editor, retained while focus moves into the chat webview. */
    private _lastActiveTextEditor: vscode.TextEditor | undefined;

    constructor() {
        const initialEditor = vscode.window.activeTextEditor;
        this._lastActiveTextEditor = initialEditor?.document.uri.scheme === 'file'
            ? initialEditor
            : undefined;
        this._registerWatchers();
        // Initial load is performed lazily or can be awaited by the caller.
    }

    public async refresh(): Promise<WorkspaceContext> {
        const [sourceFiles, headerFiles, questionFiles, questionPdfFiles, classmateFiles] = await Promise.all([
            vscode.workspace.findFiles('**/*.{c,cc,cpp,cxx}', '**/node_modules/**'),
            vscode.workspace.findFiles('**/*.{h,hh,hpp,hxx}', '**/node_modules/**'),
            vscode.workspace.findFiles('**/question.md', '**/node_modules/**'),
            vscode.workspace.findFiles('**/question.pdf', '**/node_modules/**'),
            vscode.workspace.findFiles('CLASSMATE.md', '**/.git/**', 1),
        ]);

        const allSourceFiles = [...sourceFiles, ...headerFiles].sort((a, b) =>
            a.fsPath.localeCompare(b.fsPath)
        );
        const codeDocuments = (await Promise.all(allSourceFiles.map(readCodeDocument)))
            .filter((document): document is WorkspaceCodeDocument => document !== undefined);

        const editor = vscode.window.activeTextEditor ?? this._lastActiveTextEditor;
        const selectedQuestion = selectProblemFile(questionFiles, questionPdfFiles, editor?.document.uri);
        let questionText: string | undefined;
        if (selectedQuestion && path.extname(selectedQuestion.fsPath).toLowerCase() === '.pdf') {
            try {
                questionText = formatPdfExtraction(await extractPdfUri(selectedQuestion));
            } catch (error) {
                questionText = `[Unable to parse question.pdf locally: ${error instanceof Error ? error.message : String(error)}]`;
            }
        } else if (selectedQuestion) {
            questionText = await readFirstTextFile([selectedQuestion]);
        }
        const selection = editor && !editor.selection.isEmpty
            ? editor.document.getText(editor.selection)
            : undefined;

        let courseContext: CourseContext | undefined;
        if (classmateFiles.length > 0) {
            courseContext = await parseClassmateMd(classmateFiles[0]) ?? undefined;
        }

        this._context = {
            cppFiles: allSourceFiles.map(toRelativePath),
            codeDocuments,
            codeChanges: [...this._codeChanges],
            questionText,
            questionFile: selectedQuestion ? toRelativePath(selectedQuestion) : undefined,
            activeEditor: editor ? {
                fileName: toRelativePath(editor.document.uri),
                uri: editor.document.uri.toString(),
                languageId: editor.document.languageId,
                content: editor.document.getText(),
                selection,
                selectionStartLine: !editor.selection.isEmpty ? editor.selection.start.line + 1 : undefined,
                selectionEndLine: !editor.selection.isEmpty ? editor.selection.end.line + 1 : undefined,
            } : undefined,
            courseContext,
        };

        return this._context;
    }

    public getContext(): WorkspaceContext {
        return this._context;
    }

    private _registerWatchers(): void {
        const classmateWatcher = vscode.workspace.createFileSystemWatcher('**/CLASSMATE.md');
        const questionWatcher = vscode.workspace.createFileSystemWatcher('**/question.md');
        const questionPdfWatcher = vscode.workspace.createFileSystemWatcher('**/question.pdf');
        const sourceWatcher = vscode.workspace.createFileSystemWatcher('**/*.{c,cc,cpp,cxx}');
        const headerWatcher = vscode.workspace.createFileSystemWatcher('**/*.{h,hh,hpp,hxx}');

        const onChange = () => {
            void this.refresh().then(() => this._onDidChange.fire());
        };

        classmateWatcher.onDidChange(onChange);
        classmateWatcher.onDidCreate(onChange);
        classmateWatcher.onDidDelete(onChange);

        questionWatcher.onDidChange(onChange);
        questionWatcher.onDidCreate(onChange);
        questionWatcher.onDidDelete(onChange);

        questionPdfWatcher.onDidChange(onChange);
        questionPdfWatcher.onDidCreate(onChange);
        questionPdfWatcher.onDidDelete(onChange);

        sourceWatcher.onDidCreate(onChange);
        sourceWatcher.onDidDelete(onChange);

        headerWatcher.onDidCreate(onChange);
        headerWatcher.onDidDelete(onChange);

        const recordFileChange = (uri: vscode.Uri, kind: 'file_created' | 'file_deleted') => {
            if (!isCodeFile(uri)) {
                return;
            }
            this._codeChanges.push({
                timestamp: Date.now(),
                kind,
                fileName: toRelativePath(uri),
            });
        };
        sourceWatcher.onDidCreate((uri) => recordFileChange(uri, 'file_created'));
        sourceWatcher.onDidDelete((uri) => recordFileChange(uri, 'file_deleted'));
        headerWatcher.onDidCreate((uri) => recordFileChange(uri, 'file_created'));
        headerWatcher.onDidDelete((uri) => recordFileChange(uri, 'file_deleted'));

        vscode.window.onDidChangeActiveTextEditor((editor) => {
            // VS Code reports undefined when focus moves from a source editor to
            // a webview. Do not let opening ClassMate erase the source context.
            if (editor?.document.uri.scheme === 'file') {
                this._lastActiveTextEditor = editor;
            }
            onChange();
        });
        vscode.window.onDidChangeTextEditorSelection((event) => {
            if (event.textEditor.document.uri.scheme === 'file') {
                this._lastActiveTextEditor = event.textEditor;
            }
            onChange();
        });
        vscode.workspace.onDidChangeTextDocument((event) => {
            if (event.document.uri.scheme === 'file' && isCodeFile(event.document.uri)) {
                for (const change of event.contentChanges) {
                    const kind = change.rangeLength === 0
                        ? 'insert'
                        : change.text.length === 0 ? 'delete' : 'replace';
                    this._codeChanges.push({
                        timestamp: Date.now(),
                        kind,
                        fileName: toRelativePath(event.document.uri),
                        startLine: change.range.start.line + 1,
                        startColumn: change.range.start.character + 1,
                        endLine: change.range.end.line + 1,
                        endColumn: change.range.end.character + 1,
                        insertedText: change.text || undefined,
                        removedLength: change.rangeLength || undefined,
                    });
                }
            }
            const contextEditor = vscode.window.activeTextEditor ?? this._lastActiveTextEditor;
            if (event.document === contextEditor?.document) {
                onChange();
            }
        });
    }
}
