import * as path from 'path';
import * as vscode from 'vscode';
import type { ChatSession } from '../chat/ChatSession';
import type {
    JourneyExtensionToWebviewMessage,
    JourneyWebviewToExtensionMessage,
} from '../chat/types';
import { registerSnapshot, getSnapshotUri } from '../debug/debugSnapshotProvider';
import type { DebugJourneyStore } from '../debug/debugJourneyStore';
import { isCodeModified } from '../debug/types';
import { showTextDocumentRespectingPanels } from '../ui/panelGrouping';
import { buildJourneyViewModel, type JourneyViewModel } from './journeyViewModel';

/** 视图模型节流合并窗口(设计文档 §3.5:事件写入高频,合并后整体推送)。 */
const SYNC_THROTTLE_MS = 500;

/**
 * Journey 面板的 extension 侧编排(#12a/#14a):
 * store 读接口取事件 → buildJourneyViewModel 纯函数派生 → 节流推 sync。
 * 面板不直接读 store;webview 只做渲染与交互回传。
 *
 * 动作处理(全部被动、只读或预填,不触碰「不自动修复」边界):
 * - journey:openDiff → code_modified 快照注册 + 原生 vscode.diff(只读);
 * - journey:openFile → ADD2 分组预路由(#18 零闪屏);
 * - journey:requestHint → 聚焦聊天容器 + 权威草稿广播(发送权在学生);
 * - journey:clearAll → modal 二次确认 → store.clear();
 * - journey:exportNotebook → 既有 classmate.exportDebugNotebook 命令通路。
 */
export class JourneyService {
    private readonly _store: DebugJourneyStore;
    private readonly _chatSession?: ChatSession;
    /** 可注入的二次确认(单测替换);默认 VS Code modal。 */
    private readonly _confirmClear: () => Promise<boolean>;
    private _presenter: { postMessage(message: JourneyExtensionToWebviewMessage): void } | undefined;
    private _syncTimer: ReturnType<typeof setTimeout> | undefined;
    private _disposed = false;
    private readonly _subscription: vscode.Disposable;

    constructor(
        store: DebugJourneyStore,
        options?: {
            chatSession?: ChatSession;
            confirmClear?: () => Promise<boolean>;
        }
    ) {
        this._store = store;
        this._chatSession = options?.chatSession;
        this._confirmClear =
            options?.confirmClear ??
            (async () => {
                const choice = await vscode.window.showWarningMessage(
                    '清除本工作区的调试记录?',
                    { modal: true },
                    '清除'
                );
                return choice === '清除';
            });

        // 学生继续编译/求助时新事件落盘 → 节流重算视图模型;面板未开时
        // _presenter 为空,pushState 直接短路,不产生无谓派生开销。
        this._subscription = store.onDidAppend(() => this.scheduleSync());
    }

    public dispose(): void {
        this._disposed = true;
        if (this._syncTimer) {
            clearTimeout(this._syncTimer);
            this._syncTimer = undefined;
        }
        this._subscription.dispose();
        this._presenter = undefined;
    }

    /** 面板 attach/detach;同一时刻至多一个 Journey 面板(与 RunPanel 同口径)。 */
    public async attach(presenter: {
        postMessage(message: JourneyExtensionToWebviewMessage): void;
    }): Promise<void> {
        this._presenter = presenter;
        await this.pushState();
    }

    public detach(): void {
        this._presenter = undefined;
    }

    public async handleMessage(message: JourneyWebviewToExtensionMessage): Promise<void> {
        switch (message.type) {
            case 'journey:requestState':
                await this.pushState();
                return;
            case 'journey:clearAll':
                await this.clearAll();
                return;
            case 'journey:openDiff':
                await this.openDiff(message.eventId);
                return;
            case 'journey:openFile':
                await this.openFile(message.uri, message.line);
                return;
            case 'journey:requestHint':
                this.requestHint(message.text);
                return;
            case 'journey:exportNotebook':
                await vscode.commands.executeCommand('classmate.exportDebugNotebook');
                return;
        }
    }

    /** 500ms 合并窗口:窗口内多次追加只触发一次派生与推送。 */
    public scheduleSync(): void {
        if (this._disposed || !this._presenter || this._syncTimer) {
            return;
        }
        this._syncTimer = setTimeout(() => {
            this._syncTimer = undefined;
            void this.pushState();
        }, SYNC_THROTTLE_MS);
    }

    /** 取事件 → 派生 → 整体替换推送(webview 收到 sync 后全量重渲染)。 */
    public async pushState(): Promise<void> {
        if (this._disposed || !this._presenter) {
            return;
        }
        const view = await this.buildView();
        this.post({ type: 'journey:sync', view });
    }

    public async buildView(): Promise<JourneyViewModel> {
        const events = await this._store.getEvents();
        return buildJourneyViewModel(events);
    }

    private async clearAll(): Promise<void> {
        if (!(await this._confirmClear())) {
            return;
        }
        await this._store.clear();
        this.post({ type: 'journey:cleared' });
        await this.pushState();
    }

    /**
     * 只读 diff:code_modified 事件的 before/after 注册进既有快照通路,
     * 再开原生 vscode.diff——与 sidebar 树的 openDebugNodeDiff 同底座,
     * 但直接从 store 事件取快照,不依赖树是否加载(Q6:不做回滚动作)。
     */
    private async openDiff(eventId: string): Promise<void> {
        const events = await this._store.getEvents({ types: ['code_modified'] });
        const edit = events.find((e) => isCodeModified(e) && e.id === eventId);
        if (!edit || !isCodeModified(edit)) {
            void vscode.window.showWarningMessage('这条编辑的快照已不可用(可能被轮转清理)。');
            return;
        }
        registerSnapshot(edit.id, edit.before, edit.after);
        const fileName = edit.fileUri?.split(/[\\/]/).pop() ?? '代码';
        await vscode.commands.executeCommand(
            'vscode.diff',
            getSnapshotUri(edit.id, 'before'),
            getSnapshotUri(edit.id, 'after'),
            `${fileName}(当时那次修改)`
        );
    }

    /** [在代码里看]:ADD2 统一分组打开并定位行,不经过面板组(#18 零闪屏)。 */
    private async openFile(uri: string, line?: number): Promise<void> {
        try {
            const target = resolveSourceTarget(
                uri,
                vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
            );
            if (!target) {
                void vscode.window.showWarningMessage('这是一个相对路径引用,请确认文件在工作区内。');
                return;
            }
            const document = await vscode.workspace.openTextDocument(target);
            const lastLine = Math.max(0, document.lineCount - 1);
            const targetLine = Math.min(lastLine, Math.max(0, (line ?? 1) - 1));
            await showTextDocumentRespectingPanels(document, {
                selection: new vscode.Range(targetLine, 0, targetLine, document.lineAt(targetLine).text.length),
                preview: false,
            });
        } catch {
            void vscode.window.showWarningMessage('这个文件已经打不开了(可能被移动或删除)。');
        }
    }

    /**
     * [求提示]:聚焦聊天容器 + 以权威草稿广播预填求助消息。
     * 只预填不发送(设计文档 §4.3:发送权在学生);用户正在打字时
     * 前端按 composerDraftContract 契约自动跳过 DOM 覆盖。
     */
    private requestHint(text: string): void {
        this._chatSession?.prefillInputDraft(text);
        void vscode.commands.executeCommand('classmate.openChatPanel').then(
            () => undefined,
            () => undefined
        );
    }

    private post(message: JourneyExtensionToWebviewMessage): void {
        this._presenter?.postMessage(message);
    }
}

/**
 * 诊断输出里的文件位置 → 可打开的 file URI。
 * g++ 输出可能是绝对路径(C:\ws\b.h、/usr/include/x.h)、相对路径(b.h、
 * include/b.h)或已是 file:// URI(事件级字段)。相对路径以当前工作区根解析;
 * 解不出时不给假位置(undefined)。
 */
export function resolveSourceTarget(
    fileOrUri: string,
    workspaceRootFsPath?: string
): vscode.Uri | undefined {
    if (/^file:\/\//i.test(fileOrUri)) {
        return vscode.Uri.parse(fileOrUri);
    }
    if (path.isAbsolute(fileOrUri)) {
        return vscode.Uri.file(fileOrUri);
    }
    if (workspaceRootFsPath) {
        return vscode.Uri.joinPath(
            vscode.Uri.file(workspaceRootFsPath),
            ...fileOrUri.split(/[\\/]/)
        );
    }
    return undefined;
}
