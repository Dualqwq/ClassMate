import * as vscode from 'vscode';
import type {
    WorkspaceContext,
    CourseContext,
    MinimalWorkspaceContext,
    WorkspaceCatalog,
    WorkspaceCodeChange,
    WorkspaceFileEntry,
    WorkspaceFileKind,
} from './types';
import { parseClassmateMd } from './classmateFileParser';
import * as path from 'path';
import { extractPdfUri, formatPdfExtraction } from './pdfExtractor';

const TEXT_EXTENSIONS = new Set(['.md', '.txt', '.markdown']);
const CODE_EXTENSIONS = new Set(['.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp', '.hxx']);
const BUILD_FILE_NAMES = new Set(['makefile', 'gnumakefile']);
const BUILD_EXTENSIONS = new Set(['.mk']);
const ACTIVE_FILE_PREVIEW_LIMIT = 24_000;
const WORKSPACE_FILE_LIMIT = 2_000;
const STANDARD_WORKSPACE_GLOB = '**/*.{c,cc,cpp,cxx,h,hh,hpp,hxx,md,markdown,txt,pdf}';
const BUILD_WORKSPACE_GLOB = '**/{Makefile,makefile,GNUmakefile,*.mk}';
const WORKSPACE_EXCLUDE_GLOB = '**/{node_modules,.git,.vscode-test,dist,out}/**';

function isCodeFile(uri: vscode.Uri): boolean {
    return CODE_EXTENSIONS.has(path.extname(uri.fsPath).toLowerCase());
}

function isTextFile(uri: vscode.Uri): boolean {
    const ext = uri.path.slice(uri.path.lastIndexOf('.')).toLowerCase();
    return TEXT_EXTENSIONS.has(ext);
}

export function isBuildFilePath(filePath: string): boolean {
    const fileName = path.basename(filePath).toLowerCase();
    const extension = path.extname(filePath).toLowerCase();
    return BUILD_FILE_NAMES.has(fileName) || BUILD_EXTENSIONS.has(extension);
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

export function getWorkspaceFileKind(uri: vscode.Uri): WorkspaceFileKind {
    const extension = path.extname(uri.fsPath).toLowerCase();
    const fileName = path.basename(uri.fsPath).toLowerCase();
    if (CODE_EXTENSIONS.has(extension)) {
        return 'code';
    }
    if (fileName === 'question.md') {
        return 'question';
    }
    if (fileName === 'question.pdf' || extension === '.pdf') {
        return 'pdf';
    }
    if (isBuildFilePath(uri.fsPath)) {
        return 'build';
    }
    if (TEXT_EXTENSIONS.has(extension)) {
        return 'text';
    }
    return 'other';
}

async function toCatalogEntry(uri: vscode.Uri): Promise<WorkspaceFileEntry | undefined> {
    try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.type !== vscode.FileType.File) {
            return undefined;
        }
        return {
            path: toRelativePath(uri),
            uri: uri.toString(),
            kind: getWorkspaceFileKind(uri),
            size: stat.size,
            modifiedAt: stat.mtime,
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
    private _catalog: WorkspaceCatalog = {
        files: [],
        questionFiles: [],
    };
    private readonly _codeChanges: WorkspaceCodeChange[] = [];
    /** Last real text editor, retained while focus moves into the chat webview. */
    private _lastActiveTextEditor: vscode.TextEditor | undefined;

    /**
     * Output channels, diffs, and other virtual documents can temporarily
     * become VS Code's active text editor. They are not workspace source
     * files, so keep using the most recent real file editor in that case.
     */
    private _getRelevantEditor(): vscode.TextEditor | undefined {
        const active = vscode.window.activeTextEditor;
        return active?.document.uri.scheme === 'file'
            ? active
            : this._lastActiveTextEditor;
    }

    constructor() {
        const initialEditor = vscode.window.activeTextEditor;
        this._lastActiveTextEditor = initialEditor?.document.uri.scheme === 'file'
            ? initialEditor
            : undefined;
        this._registerWatchers();
        // Initial load is performed lazily or can be awaited by the caller.
    }

    public async refreshCatalog(): Promise<WorkspaceCatalog> {
        const [standardUris, buildUris] = await Promise.all([
            vscode.workspace.findFiles(
                STANDARD_WORKSPACE_GLOB,
                WORKSPACE_EXCLUDE_GLOB,
                WORKSPACE_FILE_LIMIT
            ),
            vscode.workspace.findFiles(
                BUILD_WORKSPACE_GLOB,
                WORKSPACE_EXCLUDE_GLOB,
                WORKSPACE_FILE_LIMIT
            ),
        ]);
        const uris = [...new Map(
            [...standardUris, ...buildUris].map((uri) => [uri.toString(), uri])
        ).values()].slice(0, WORKSPACE_FILE_LIMIT);
        const entries = (await Promise.all(uris.map(toCatalogEntry)))
            .filter((entry): entry is WorkspaceFileEntry => entry !== undefined)
            .sort((a, b) => a.path.localeCompare(b.path));
        const editor = this._getRelevantEditor();
        const classmateFile = entries.find(
            (entry) => path.basename(entry.path).toLowerCase() === 'classmate.md'
        );
        this._catalog = {
            files: entries,
            questionFiles: entries
                .filter((entry) =>
                    path.basename(entry.path).toLowerCase() === 'question.md' ||
                    path.basename(entry.path).toLowerCase() === 'question.pdf'
                )
                .map((entry) => entry.path),
            classmateFile: classmateFile?.path,
            activeEditor: editor ? {
                fileName: toRelativePath(editor.document.uri),
                uri: editor.document.uri.toString(),
                languageId: editor.document.languageId,
                selection: !editor.selection.isEmpty
                    ? editor.document.getText(editor.selection)
                    : undefined,
                selectionStartLine: !editor.selection.isEmpty ? editor.selection.start.line + 1 : undefined,
                selectionEndLine: !editor.selection.isEmpty ? editor.selection.end.line + 1 : undefined,
            } : undefined,
        };
        return this._catalog;
    }

    public getCatalog(): WorkspaceCatalog {
        return this._catalog;
    }

    public async getMinimalContext(): Promise<MinimalWorkspaceContext> {
        const catalog = await this.refreshCatalog();
        const editor = this._getRelevantEditor();
        const questionEntries = catalog.files.filter(
            (entry) => path.basename(entry.path).toLowerCase() === 'question.md'
        );
        const questionPdfEntries = catalog.files.filter(
            (entry) => path.basename(entry.path).toLowerCase() === 'question.pdf'
        );
        const selectedQuestion = selectProblemFile(
            questionEntries.map((entry) => vscode.Uri.parse(entry.uri)),
            questionPdfEntries.map((entry) => vscode.Uri.parse(entry.uri)),
            editor?.document.uri
        );
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
        const classmateEntry = catalog.files.find(
            (entry) => path.basename(entry.path).toLowerCase() === 'classmate.md'
        );
        if (classmateEntry) {
            courseContext = await parseClassmateMd(vscode.Uri.parse(classmateEntry.uri)) ?? undefined;
        }

        return {
            catalog,
            activeSelection: selection,
            activeFilePreview: editor
                ? editor.document.getText().slice(0, ACTIVE_FILE_PREVIEW_LIMIT)
                : undefined,
            questionText,
            questionFile: selectedQuestion ? toRelativePath(selectedQuestion) : undefined,
            courseContext,
        };
    }

    public async refresh(): Promise<WorkspaceContext> {
        const minimal = await this.getMinimalContext();
        const editor = this._getRelevantEditor();
        this._context = {
            cppFiles: minimal.catalog.files
                .filter((entry) => entry.kind === 'code')
                .map((entry) => entry.path),
            codeDocuments: [],
            codeChanges: [...this._codeChanges],
            questionText: minimal.questionText,
            questionFile: minimal.questionFile,
            activeEditor: editor ? {
                fileName: toRelativePath(editor.document.uri),
                uri: editor.document.uri.toString(),
                languageId: editor.document.languageId,
                content: minimal.activeFilePreview ?? '',
                selection: minimal.activeSelection,
                selectionStartLine: !editor.selection.isEmpty ? editor.selection.start.line + 1 : undefined,
                selectionEndLine: !editor.selection.isEmpty ? editor.selection.end.line + 1 : undefined,
            } : undefined,
            courseContext: minimal.courseContext,
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
        const buildWatcher = vscode.workspace.createFileSystemWatcher(BUILD_WORKSPACE_GLOB);

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

        buildWatcher.onDidChange(onChange);
        buildWatcher.onDidCreate(onChange);
        buildWatcher.onDidDelete(onChange);

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
            const contextEditor = this._getRelevantEditor();
            if (event.document === contextEditor?.document) {
                onChange();
            }
        });
    }
}
