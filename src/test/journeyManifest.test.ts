import * as assert from 'assert';
import { describe, it } from 'mocha';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Journey 入口 manifest 完整性(docs/journey-panel-state-machine.md §4 不变量)。
 * 锁死三条不变量:
 * ①命令唯一注册面(contributes.commands 存在且带 title/icon);
 * ②一切 journey 菜单入口只引用 classmate.debugJourney 这一个 command id;
 * ③menus 引用的每个 command 都已声明(navigation/inline 组还必须有 icon),
 *   view/title 的 when 只指向已注册视图。
 * 防回归锚点:任何按钮/入口改动若造成悬空引用或绕开权威命令,这里先红。
 */

interface MenuEntry {
    command: string;
    group?: string;
    when?: string;
}

interface CommandDecl {
    command: string;
    title: string;
    icon?: string;
}

function loadPackageJson(): {
    commands: CommandDecl[];
    views: Record<string, Array<{ id: string }>>;
    menus: Record<string, MenuEntry[]>;
} {
    // out/test/*.test.js → 仓库根两层之上。
    const raw = fs.readFileSync(
        path.resolve(__dirname, '..', '..', 'package.json'),
        'utf-8'
    );
    return JSON.parse(raw).contributes;
}

describe('journey 入口 manifest 完整性(状态机 §4 不变量)', () => {
    const contributes = loadPackageJson();
    const registeredCommands = new Set(contributes.commands.map((c) => c.command));
    const commandById = new Map(contributes.commands.map((c) => [c.command, c]));
    const registeredViewIds = new Set(
        Object.values(contributes.views ?? {}).flatMap((views) =>
            views.map((v) => v.id)
        )
    );

    it('不变量1:classmate.debugJourney 已在 contributes.commands 注册并带图标', () => {
        const decl = commandById.get('classmate.debugJourney');
        assert.ok(decl, 'contributes.commands 必须声明 classmate.debugJourney');
        assert.strictEqual(decl.title, 'Open Debug Journey');
        assert.ok(decl.icon, 'view/title 与 inline 组要求命令带 icon');
    });

    it('不变量3:所有菜单条目引用的命令都已声明,无悬空引用', () => {
        for (const [menu, entries] of Object.entries(contributes.menus)) {
            for (const entry of entries) {
                assert.ok(
                    registeredCommands.has(entry.command),
                    `${menu} 引用了未声明的命令 ${entry.command}`
                );
            }
        }
    });

    it('不变量2:一切 journey 菜单入口只收敛到 classmate.debugJourney', () => {
        // journey 相关既有命令全集:权威入口 + 树自身的刷新/关闭/树项 diff。
        // 新增任何平行 journey 命令都必须先改本白名单与状态机文档,防止绕开
        // 权威入口另起路径(状态机 §4 不变量 2)。
        const JOURNEY_COMMAND_ALLOWLIST = new Set([
            'classmate.debugJourney',
            'classmate.refreshDebugJourneyTree',
            'classmate.closeDebugJourneyTree',
            'classmate.openDebugNodeDiff',
        ]);
        const authoritativeEntries: Array<{ menu: string; entry: MenuEntry }> = [];
        for (const [menu, entries] of Object.entries(contributes.menus)) {
            // commandPalette 是命令可见性声明,不属于「小屏按钮」矩阵(§3 入口矩阵只数按钮面)。
            if (menu === 'commandPalette') {
                continue;
            }
            for (const entry of entries) {
                if (/journey/i.test(entry.command)) {
                    assert.ok(
                        JOURNEY_COMMAND_ALLOWLIST.has(entry.command),
                        `菜单 ${menu} 引用了白名单之外的 journey 命令 ${entry.command}`
                    );
                }
                if (entry.command === 'classmate.debugJourney') {
                    authoritativeEntries.push({ menu, entry });
                }
            }
        }
        // 状态机 §3 入口矩阵:五个小屏入口全部在场(命令面板本身不经菜单)。
        const locations = authoritativeEntries.map(({ menu }) => menu).sort();
        assert.deepStrictEqual(locations, [
            'editor/title',
            'view/item/context',
            'view/item/context',
            'view/title',
            'view/title',
        ]);
    });

    it('不变量6:navigation/inline 组的命令必须有图标;when 指向已注册视图', () => {
        for (const [menu, entries] of Object.entries(contributes.menus)) {
            for (const entry of entries) {
                const inNavigationGroup = /^(inline|navigation)@/.test(entry.group ?? '');
                if (inNavigationGroup) {
                    assert.ok(
                        commandById.get(entry.command)?.icon,
                        `${menu} ${entry.command}: navigation/inline 组要求 icon`
                    );
                }
                const when = entry.when ?? '';
                for (const match of when.matchAll(/view\s*==\s*([\w.]+)/g)) {
                    assert.ok(
                        registeredViewIds.has(match[1]),
                        `${menu} ${entry.command}: when 引用未注册视图 ${match[1]}`
                    );
                }
            }
        }
    });

    it('树项动作的 viewItem 与树节点 contextValue 匹配(compileErrorNode)', () => {
        const contextEntries =
            contributes.menus['view/item/context']?.filter(
                (e) => e.command === 'classmate.debugJourney'
            ) ?? [];
        assert.ok(contextEntries.length > 0, '树项动作应存在');
        for (const entry of contextEntries) {
            assert.match(
                entry.when ?? '',
                /viewItem == compileErrorNode/,
                'view/item/context 必须约束到具体 contextValue'
            );
        }
    });
});
