import * as vscode from 'vscode';
import type { WorkspaceContext, CourseContext } from './types';
import { parseClassmateMd } from './classmateFileParser';

const TEXT_EXTENSIONS = new Set(['.md', '.txt', '.markdown']);

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

/**
 * Scans the active workspace for project context:
 * - C++ source/header files
 * - question/ folder description
 * - CLASSMATE.md course configuration
 *
 * Watches CLASSMATE.md and the question/ folder for changes and exposes an
 * event so consumers can react to updated context.
 */
export class WorkspaceContextProvider {
    private readonly _onDidChange = new vscode.EventEmitter<void>();
    public readonly onDidChange = this._onDidChange.event;

    private _context: WorkspaceContext = {
        cppFiles: [],
    };

    constructor() {
        this._registerWatchers();
        // Initial load is performed lazily or can be awaited by the caller.
    }

    public async refresh(): Promise<WorkspaceContext> {
        const [cppFiles, headerFiles, questionFiles, classmateFiles] = await Promise.all([
            vscode.workspace.findFiles('**/*.cpp', '**/node_modules/**'),
            vscode.workspace.findFiles('**/*.h', '**/node_modules/**'),
            vscode.workspace.findFiles('question/*', '**/node_modules/**'),
            vscode.workspace.findFiles('CLASSMATE.md', '**/.git/**', 1),
        ]);

        const allSourceFiles = [...cppFiles, ...headerFiles].sort((a, b) =>
            a.fsPath.localeCompare(b.fsPath)
        );

        const questionText = questionFiles.length > 0
            ? await readFirstTextFile(questionFiles)
            : undefined;

        let courseContext: CourseContext | undefined;
        if (classmateFiles.length > 0) {
            courseContext = await parseClassmateMd(classmateFiles[0]) ?? undefined;
        }

        this._context = {
            cppFiles: allSourceFiles.map(toRelativePath),
            questionText,
            courseContext,
        };

        return this._context;
    }

    public getContext(): WorkspaceContext {
        return this._context;
    }

    private _registerWatchers(): void {
        const classmateWatcher = vscode.workspace.createFileSystemWatcher('**/CLASSMATE.md');
        const questionWatcher = vscode.workspace.createFileSystemWatcher('**/question/*');
        const cppWatcher = vscode.workspace.createFileSystemWatcher('**/*.cpp');
        const headerWatcher = vscode.workspace.createFileSystemWatcher('**/*.h');

        const onChange = () => {
            void this.refresh().then(() => this._onDidChange.fire());
        };

        classmateWatcher.onDidChange(onChange);
        classmateWatcher.onDidCreate(onChange);
        classmateWatcher.onDidDelete(onChange);

        questionWatcher.onDidChange(onChange);
        questionWatcher.onDidCreate(onChange);
        questionWatcher.onDidDelete(onChange);

        cppWatcher.onDidCreate(onChange);
        cppWatcher.onDidDelete(onChange);

        headerWatcher.onDidCreate(onChange);
        headerWatcher.onDidDelete(onChange);
    }
}
