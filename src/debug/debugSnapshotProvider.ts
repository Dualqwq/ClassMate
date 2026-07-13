import * as vscode from 'vscode';

const SNAPSHOT_SCHEME = 'classmate-debug-snapshot';

interface SnapshotEntry {
    before: string;
    after: string;
}

const snapshots = new Map<string, SnapshotEntry>();

function encodeSnapshotUri(eventId: string, side: 'before' | 'after'): vscode.Uri {
    // Use query parameters so the same eventId can serve two sides.
    const query = new URLSearchParams({ side });
    return vscode.Uri.from({
        scheme: SNAPSHOT_SCHEME,
        authority: 'classmate',
        path: `/${encodeURIComponent(eventId)}`,
        query: query.toString(),
    });
}

export function registerSnapshot(eventId: string, before: string, after: string): void {
    snapshots.set(eventId, { before, after });
}

export function getSnapshotUri(eventId: string, side: 'before' | 'after'): vscode.Uri {
    return encodeSnapshotUri(eventId, side);
}

export function getSnapshotEntry(eventId: string): SnapshotEntry | undefined {
    return snapshots.get(eventId);
}

export function clearSnapshots(): void {
    snapshots.clear();
}

class DebugSnapshotProvider implements vscode.TextDocumentContentProvider {
    private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
    public readonly onDidChange = this._onDidChange.event;

    provideTextDocumentContent(uri: vscode.Uri): string {
        const eventId = decodeURIComponent(uri.path.replace(/^\//, ''));
        const side = new URLSearchParams(uri.query).get('side') as 'before' | 'after' | null;
        const entry = snapshots.get(eventId);
        if (!entry || !side) {
            return '';
        }
        return entry[side];
    }

    public fireChange(uri: vscode.Uri): void {
        this._onDidChange.fire(uri);
    }
}

export function registerDebugSnapshotProvider(context: vscode.ExtensionContext): DebugSnapshotProvider {
    const provider = new DebugSnapshotProvider();
    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider(SNAPSHOT_SCHEME, provider)
    );
    return provider;
}
