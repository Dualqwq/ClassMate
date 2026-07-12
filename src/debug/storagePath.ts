import * as vscode from 'vscode';
import * as crypto from 'crypto';

const DEBUG_JOURNEY_DIR = 'debug-journey';
const SINGLE_FILE_WORKSPACE = 'single-file';

function sanitizeWorkspaceId(input: string): string {
    // Use a short SHA256 hash so the id is filesystem-safe and stable.
    return crypto.createHash('sha256').update(input).digest('hex').slice(0, 16);
}

export function getWorkspaceId(): string {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        return SINGLE_FILE_WORKSPACE;
    }
    // Use the first workspace folder as the stable identifier.
    return sanitizeWorkspaceId(folders[0].uri.toString());
}

export function getWorkspaceStorageUri(globalStorage: vscode.Uri, workspaceId: string): vscode.Uri {
    return vscode.Uri.joinPath(globalStorage, DEBUG_JOURNEY_DIR, workspaceId);
}

export function getEventsFileUri(workspaceStorage: vscode.Uri): vscode.Uri {
    return vscode.Uri.joinPath(workspaceStorage, 'events.jsonl');
}

export function getIndexFileUri(workspaceStorage: vscode.Uri): vscode.Uri {
    return vscode.Uri.joinPath(workspaceStorage, 'index.json');
}
