import * as assert from 'assert';
import { describe, it } from 'mocha';
import * as vscode from 'vscode';
import { openJourneyPanel } from '../ui/JourneyPanel';
import { DebugJourneyStore } from '../debug/debugJourneyStore';
import { JourneyService } from '../journey/journeyService';

/**
 * classmate.debugJourney 命令路径回归(docs/journey-panel-state-machine.md §3)。
 * 用户报告「命令面板也打不开大屏」后的防回归锚点:在真实扩展宿主里把
 * 命令面板路径与权威入口路径各走一遍。
 * 断言口径:不依赖 JourneyPanel 静态单例(扩展跑 webpack dist 自带类副本,
 * 与测试导入的 out 副本静态不互通),改用可观测 UI 事实——tabGroups 中
 * viewType === 'classmate.journeyPanel' 的 TabInputWebview 标签。
 */

function countJourneyTabs(): number {
    return vscode.window.tabGroups.all
        .flatMap((group) => group.tabs)
        .filter((tab) => {
            const input = tab.input;
            return (
                input instanceof vscode.TabInputWebview &&
                input.viewType === 'classmate.journeyPanel'
            );
        }).length;
}

async function waitUntil(
    condition: () => boolean,
    timeoutMs = 10_000
): Promise<void> {
    const start = Date.now();
    while (!condition()) {
        if (Date.now() - start > timeoutMs) {
            assert.fail('waitUntil 超时');
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
}

async function closeAllJourneyPanels(): Promise<void> {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await waitUntil(() => countJourneyTabs() === 0);
}

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

describe('classmate.debugJourney 命令路径(状态机 §3 权威入口)', () => {
    it('命令面板路径:执行后大屏标签创建;重复执行 reveal 不重建(标签数不变)', async () => {
        await closeAllJourneyPanels();
        await vscode.commands.executeCommand('classmate.debugJourney');
        await waitUntil(() => countJourneyTabs() === 1);
        assert.strictEqual(countJourneyTabs(), 1, '执行命令后应恰好有一个大屏标签');

        // 已打开再执行 = reveal 聚焦,不得重建(标签数不变、无第二实例)。
        await vscode.commands.executeCommand('classmate.debugJourney');
        assert.strictEqual(countJourneyTabs(), 1, '重复执行不得重建出第二个面板');
    });

    it('关闭后重开:dispose 后同一命令可再次打开', async () => {
        await closeAllJourneyPanels();
        await vscode.commands.executeCommand('classmate.debugJourney');
        await waitUntil(() => countJourneyTabs() === 1);

        await closeAllJourneyPanels();
        await vscode.commands.executeCommand('classmate.debugJourney');
        await waitUntil(() => countJourneyTabs() === 1);
        assert.strictEqual(countJourneyTabs(), 1, '重开后大屏应可用');

        await closeAllJourneyPanels();
    });

    it('openJourneyPanel 权威入口与命令路径等价', async () => {
        await closeAllJourneyPanels();
        const extensionUri =
            vscode.extensions.getExtension('classmate')?.extensionUri ??
            vscode.Uri.file(process.cwd());
        const store = new DebugJourneyStore(createStubContext(), 'journeycmd-test');
        const service = new JourneyService(store);
        try {
            openJourneyPanel(extensionUri, service);
            await waitUntil(() => countJourneyTabs() === 1);

            // 与命令路径同口径:重复调用幂等(reveal 不重建)。
            openJourneyPanel(extensionUri, service);
            assert.strictEqual(countJourneyTabs(), 1);
        } finally {
            service.dispose();
            store.dispose();
            await closeAllJourneyPanels();
        }
    });
});
