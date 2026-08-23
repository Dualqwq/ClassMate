import * as assert from 'assert';
import { describe, it } from 'mocha';
import * as vscode from 'vscode';
import { JourneyPanel, openJourneyPanel } from '../ui/JourneyPanel';
import { DebugJourneyStore } from '../debug/debugJourneyStore';
import { JourneyService } from '../journey/journeyService';

/**
 * classmate.debugJourney 命令路径回归(docs/journey-panel-state-machine.md §3)。
 * 用户报告「命令面板也打不开大屏」后的防回归锚点:在真实扩展宿主里把
 * 命令面板路径与权威入口路径各走一遍,锁定:
 * ①命令执行后大屏创建(hasCurrent);②重复执行 reveal 不重建不抛错;
 * ③关闭后重开语义(onDidDispose → _currentPanel 置空 → 可再次打开);
 * ④openJourneyPanel 权威入口与命令路径行为等价。
 */

function createStubContext(): vscode.ExtensionContext {
    const state = new Map<string, unknown>();
    return {
        globalStorageUri: vscode.Uri.file(
            `${process.env.TEMP ?? '/tmp'}/classmate-journeycmd-${Date.now()}-${Math.random()
                .toString(36)
                .slice(2, 9)}`
        ),
        globalState: {
            get: <T>(key: string, defaultValue?: T): T | undefined => {
                return state.has(key) ? (state.get(key) as T) : defaultValue;
            },
            update: async (key: string, value: unknown) => {
                if (value === undefined) {
                    state.delete(key);
                } else {
                    state.set(key, value);
                }
            },
        },
    } as unknown as vscode.ExtensionContext;
}

async function waitUntil(
    condition: () => boolean,
    timeoutMs = 5_000
): Promise<void> {
    const start = Date.now();
    while (!condition()) {
        if (Date.now() - start > timeoutMs) {
            assert.fail('waitUntil 超时');
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
}

describe('classmate.debugJourney 命令路径(状态机 §3 权威入口)', () => {
    it('命令面板路径:执行后大屏创建;重复执行 reveal 不重建不抛错', async () => {
        await vscode.commands.executeCommand('classmate.debugJourney');
        assert.strictEqual(JourneyPanel.hasCurrent(), true, '执行命令后大屏应已创建');

        // 已打开再执行 = reveal 聚焦,不得重建或抛错。
        await vscode.commands.executeCommand('classmate.debugJourney');
        assert.strictEqual(JourneyPanel.hasCurrent(), true);
    });

    it('关闭后重开:dispose 置空单例后,同一命令可再次打开', async () => {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        await waitUntil(() => !JourneyPanel.hasCurrent());

        await vscode.commands.executeCommand('classmate.debugJourney');
        assert.strictEqual(JourneyPanel.hasCurrent(), true, '重开后大屏应可用');

        // 收尾:不留面板干扰后续套件。
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        await waitUntil(() => !JourneyPanel.hasCurrent());
    });

    it('openJourneyPanel 权威入口与命令路径等价', async () => {
        const extensionUri =
            vscode.extensions.getExtension('classmate')?.extensionUri ??
            vscode.Uri.file(process.cwd());
        const store = new DebugJourneyStore(createStubContext(), 'journeycmd-test');
        const service = new JourneyService(store);
        try {
            openJourneyPanel(extensionUri, service);
            assert.strictEqual(JourneyPanel.hasCurrent(), true);

            // 与命令路径同口径:重复调用幂等(reveal 不重建)。
            openJourneyPanel(extensionUri, service);
            assert.strictEqual(JourneyPanel.hasCurrent(), true);
        } finally {
            service.dispose();
            store.dispose();
            await vscode.commands.executeCommand('workbench.action.closeAllEditors');
            await waitUntil(() => !JourneyPanel.hasCurrent());
        }
    });
});
