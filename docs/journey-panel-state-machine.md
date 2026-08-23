# Journey 大屏/小屏入口状态机(#12a,轨 FE1)

> 状态:定稿(2026-08-23)。本文是大屏入口实现与复审的唯一依据:任何入口
> (命令面板、标题栏按钮、树项动作)必须收敛到同一个权威入口,不得另起路径。
> 依据代码:`src/ui/JourneyPanel.ts`、`src/journey/journeyService.ts`、
> `src/extension.ts`(命令注册段)、`package.json`(contributes)、
> `src/ui/panelGrouping.ts`(B1 分组注册表)、`docs/frontend-teaching-design.md` §3。

## 1. 表面清单(是什么)

| 表面 | VS Code 形态 | id | 生命周期归属 |
| --- | --- | --- | --- |
| **大屏** Journey 面板 | `WebviewPanel`(editor 区大标签页,常驻 `retainContextWhenHidden`) | `classmate.journeyPanel` | `JourneyPanel._currentPanel` 单例静态持有 |
| 小屏:Debug Journey 树 | `TreeView`(classmate-sidebar-v2 容器内) | `classmate.debugJourneyTree` | `DebugJourneyTreeProvider`,activate 注册 |
| 小屏:ChatView 标题栏按钮 | view/title menu(挂在 ChatView 上) | —(只是菜单项) | package.json 声明 |
| 小屏:树标题栏按钮 | view/title menu(挂树上) | — | 同上 |
| 小屏:树项行内/右键动作 | view/item/context menu(error 节点) | — | 同上 |
| 小屏:编辑器工具栏按钮 | editor/title menu(C/C++ 文件) | — | 同上 |
| 共享 bundle | 单一 React bundle `dist/webview.js` + 注入路由 | `__CLASSMATE_ROUTE__ = 'chat' \| 'run' \| 'journey'` | route 在页面生命周期内不变 |

要点:**所有"小屏"都只是菜单项,自身无状态**;唯一有状态的大屏实体是
Journey 面板单例。菜单项点击 = 执行命令 `classmate.debugJourney`,与命令面板
完全同一路径——不存在"按钮路径"与"命令路径"两套代码。

## 2. 状态

### 2.1 大屏(JourneyPanel)

| 状态 | 含义 | 判定 |
| --- | --- | --- |
| `NotCreated` | 本窗口从未创建,或已关闭(onDidDispose 已把 `_currentPanel` 置空) | `!JourneyPanel.hasCurrent()` |
| `CreatedHidden` | 已创建但标签不可见(被切走/被遮挡;retainContextWhenHidden 保状态) | `hasCurrent() && !panel.active` |
| `CreatedVisible` | 已创建且可见 | `hasCurrent() && panel.active` |

`focus` 不是独立状态:`createOrShow` 的第二参 `preserveFocus=false`(默认)
即"reveal 并抢焦点";需要不抢焦道的调用方显式传 true。

### 2.2 小屏

- 树:`classmate.debugJourneyTree.enabled` context key 控制 when;activate 时置
  true,`classmate.closeDebugJourneyTree` 命令置 false(只隐藏视图,不影响数据)。
- 各菜单项:无独立状态;可见性由 when 子句求值(view/viewItem/editorLangId/
  chatContainer 等 context key)。

### 2.3 路由

route 由各 HTML 模板硬编码注入(Chat→`chat`、Run→`run`、Journey→`journey`),
页面生命周期内不变;不存在运行时切换,App.tsx 按 route 提前 return 分发。

## 3. 转换(每个入口走哪条路)

**权威入口(唯一)**:

```
classmate.debugJourney 命令(extension.ts 注册一次)
  └─ handler: JourneyPanel.createOrShow(context.extensionUri, journeyService)
       ├─ hasCurrent()? → _currentPanel.reveal(activeColumn, preserveFocus=false)
       │                  (不重建、不重发 HTML;数据仍由 onDidAppend 节流刷新)
       ├─ resolveNewPanelColumn(...)      ← B1 分组决策(不盖源码)
       ├─ createWebviewPanel(...)         ← getJourneyWebviewHtml 注入 route 'journey'
       ├─ registerClassMatePanel(...)     ← 登记分组注册表(ADD2 预路由生效的前提)
       └─ journeyService.attach(panel)    ← 取事件→派生→推 journey:sync
```

| # | 入口 | 触达方式 | 收敛点 |
| --- | --- | --- | --- |
| 1 | 命令面板 | 执行 `ClassMate: Open Debug Journey` | 权威入口 |
| 2 | 编辑器工具栏按钮(editor/title,C/C++) | `menus.editor/title → classmate.debugJourney` | 同一条命令 |
| 3 | Journey 树标题栏按钮(view/title) | `menus.view/title → classmate.debugJourney` | 同一条命令 |
| 4 | ChatView 标题栏按钮(view/title) | 同上 | 同一条命令 |
| 5 | 树项行内图标/右键(view/item/context,error 节点) | 同上 | 同一条命令 |

补充语义:

- **已打开时**:reveal 到 active 列并聚焦,不重建(`_currentPanel` 复用);
- **B1 分组/搬迁**:新建落列由 `resolveNewPanelColumn` 决定(active 为
  compile_result.txt 时与它同组);此后任何 ClassMate 面板 active 时新开的
  文本文件经 relocation 兜底挪去对侧(`_handleTabChange`);
- **关闭后重开**:onDidDispose → `journeyService.detach()` +
  `_currentPanel=undefined`;再进任意入口 = 全新创建,数据在 attach 时重取,
  无陈旧状态残留;
- **[在代码里看]/[看 diff]** 是反向转换(大屏 → 编辑器/diff),走
  `journey:openFile` / `journey:openDiff` 消息,与本状态机的"开大屏"方向
  无关,不得复用 `classmate.debugJourney` 命令。

## 4. 不变量(复审逐条对照)

1. **命令唯一注册**:`classmate.debugJourney` 全仓恰好一处
   `registerCommand`(extension.ts commands 数组);任何 PR 引入第二处即为缺陷。
2. **入口全部收敛**:contributes.menus 中一切 journey 入口只允许引用
   `classmate.debugJourney` 这一个 command id;不允许为按钮新建平级命令。
3. **引用必须存在**:menus 引用的每个 command 必须已在 contributes.commands
   声明且被 extension.ts 注册(有 manifest 完整性单测锁定)。
4. **不绕过分组注册表**:大屏创建必须经权威入口 `openJourneyPanel`
   (内部收敛到单例 `JourneyPanel.createOrShow`,完成 registerClassMatePanel);
   禁止绕过它们直接 createWebviewPanel。
5. **handler 只做打开**:handler 内不做一次性初始化以外的事(服务在 activate
   构造一次);禁止在 handler 里写全局状态/重复 attach。
6. **菜单声明与视图匹配**:view/title 条目的 when 必须写 `view == <已注册视图>`;
   view/item/context 必须同时约束 `viewItem == <节点 contextValue>`。
