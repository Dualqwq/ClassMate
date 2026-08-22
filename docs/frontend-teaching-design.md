# ClassMate 前端呈现与教学体验设计(#12 / #13 / #14)

> 状态:已定稿(2026-08-22 用户拍板:Q4 N=3,其余 Q1–Q10 按推荐)。
> 依据:`docs/event-schema-design.md`(数据层契约,已定稿——本文的事件定义、
> 读接口、隐私边界一律以其为准,不另起数据模型)、`plan-todo-priorities-20260820.md`
> §二 P3 第 9 项与 §3.1(#12/13/14 行:先出 schema 再写码)、
> `0803后要干的事情.md` #12/#13/#14 原文、`CLAUDE.md` 教学边界。
> 范围:**纯前端呈现与教学体验设计**——容器形态、组件复用、交互流程、引导节奏、
> 提示层级、与「不自动补全/不自动修复」边界的关系、事件对接、分期建议。
> 不含实现代码;schema 未定的开放问题(Q1–Q7)本文只引用结论,不重复拍板。

## 1. 背景与目标

#12(Debug Journey 升级)、#13(Debug Journey 接入 Agent 工作流)、#14(逐工作区
错题本)在数据层已统一:三者消费同一份事件流(`events.jsonl`,v2 schema),
经同一组确定性派生纯函数读出。本文补齐数据层之上的另一半:**这些东西在学生
屏幕上长什么样、以什么节奏出现、如何守住教学边界**。

设计目标:

1. **#12**:把现有 sidebar  TreeView 的简陋展示升级为可过滤、可还原时间线的
   调试历程视图,呈现力配得上 v2 事件流;
2. **#13**:让 Agent 回答能引用学生的调试历史,并给学生一个看得懂的复习入口;
   Agent 上下文注入本身无 UI,但「被注入了什么」对学生应有恰当的可见性;
3. **#14**:在事件流上长出可复习的错题本界面——题目级聚合、错误卡片、版本链、
   复习模式、可控导出。

贯穿约束(CLAUDE.md):不自动补全、不自动修复学生代码,任何修改需学生显式
确认;一切自动出现的干预必须 passive-triggered、dismissible、frequency-limited。

## 2. 前端现状盘点(三个功能的起点)

| 资产 | 位置 | 现状要点 |
| --- | --- | --- |
| sidebar 容器 | `package.json` → `classmate-sidebar-v2` | 内含 ChatView(webview,`initialSize: 2`)与 Debug Journey 树(`classmate.debugJourneyTree`,tree,`initialSize: 1`)两个视图 |
| Debug Journey 树 | `src/ui/DebugJourneyTreeProvider.ts` + `src/debug/debugJourneyTreeNodes.ts` | 文件 → 日期 → 事件三级树;节点类型 compile_error/compile_success/code_modified/hint_requested/run_error;`codeModifiedNode` 点击开 diff(`classmate.openDebugNodeDiff`);#5 已过滤不存在文件;标题栏有刷新/关闭/导出错题本按钮。TreeView API 表现上限低(纯文本行 + tooltip markdown),承载不了 v2 的 episode 时间线 |
| 聊天双容器 | `src/ui/chatContainer.ts`(#16 状态机)、`src/ui/ChatPanel.ts`、`ChatViewProvider.ts` | view/panel/hidden 三态 + context key 驱动 when 子句;ChatPanel 为 editor 区大标签页 |
| 面板分组注册表 | `src/ui/panelGrouping.ts`(B1 已合入) | `registerClassMatePanel` 登记任意 ClassMate 大屏面板;`resolveNewPanelColumn` 定新建面板列;`showTextDocumentRespectingPanels` 实现 ADD2 统一文件打开逻辑(#18 零闪屏路径)。**新大屏面板直接复用,不另起分组逻辑** |
| 共享 webview bundle | `webview/esbuild.js`、`src/ui/getChatWebviewHtml.ts` | 单 React bundle;route 信息以全局变量注入(`window.__CLASSMATE_CONTAINER__`,getChatWebviewHtml.ts:18);grill R2-Q3 已定 Run Panel 与 Chat Panel 共享 bundle + route 切换——**同一机制顺延给 #12/#14** |
| 消息桥契约 | `src/chat/types.ts` | webview ↔ extension 消息类型先在此定义(AGENTS.md 契约);新 route 的消息同理 |
| 回答内引用渲染 | `webview/src/components/MarkdownRenderer.tsx` | answer references 渲染为行内链接,派发 `openReference` 打开代码——**#13 复习入口可复用的现成链路** |
| 派生层(纯函数) | `src/debug/` | `buildErrorLifecycles`(错误 episode)、`mergeAndSortKnowledgeCards`(归卡)、`buildJourneySummary`(指标)、`buildNotebookInput`(导出输入)、`analytics.ts`(求助比例/独立修复率等)——全部已存在,schema §8 承诺签名保持 |
| 存储读面 | `src/debug/debugJourneyStore.ts` | `getEvents(filter)` / `getIndex()` / `clear()`;消费者统一只经此读接口,不碰文件 |

## 3. 共用呈现基座(三个功能都站在上面)

三个功能的大屏呈现共用同一套基座,避免各起炉灶:

1. **共享 bundle + route**:#12/#14 的大屏视图作为同一 React bundle 的新 route
   加入(与 Chat、Run 并列)。注入机制把现有 `__CLASSMATE_CONTAINER__` 泛化
   为 route 声明(如 `__CLASSMATE_ROUTE__: 'chat' | 'run' | 'journey'`),由
   `getChatWebviewHtml.ts` 统一注入,App.tsx 顶层按 route 分发渲染。
2. **面板注册与分组**:每个新 WebviewPanel 创建时调 `registerClassMatePanel`
   登记、dispose 时注销;新建列用 `resolveNewPanelColumn`;面板内一切打开
   文件的动作走 `showTextDocumentRespectingPanels`(ADD2 统一逻辑,#18
   零闪屏)。面板常驻、关闭后重开状态仍在(与 Run Panel 同生命周期口径)。
3. **数据通路(extension host 侧)**:面板不直接读 `DebugJourneyStore`;由
   extension host 经读接口取事件 → 跑派生纯函数 → 把「视图模型」(episode
   列表、卡片列表、指标)经消息桥推给 webview。webview 只做渲染与交互回传,
   不在前端重算聚合——聚合逻辑留在可单测的纯函数里。
4. **新消息类型先过契约**:如 `requestJourneyView` / `journeyViewSync` /
   `openJourneyEpisode` 等,一律先加进 `src/chat/types.ts` 再实现。
5. **刷新策略**:事件写入是高频动作(每次编译/运行都追加)。视图模型在
   extension 侧节流重算(如 500ms 合并窗口),webview 收到 sync 整体替换
   渲染;不逐事件推流。

## 4. #12 Debug Journey 升级

### 4.1 呈现形态

**容器:editor 区大标签页 WebviewPanel(route `journey`),与 Chat Panel /
Run Panel 同级**;打开走 `resolveNewPanelColumn` 分组策略。原 sidebar
TreeView **保留但收窄为「精简入口」**:只显示最近 N 条与未解决错误(顶置),
标题栏加「打开完整视图」按钮——TreeView 的纯文本形态做摘要正好,时间线呈现
交给大屏。是否整体下线树见开放问题 Q1。

**新建组件(webview 内,route `journey` 下)**:

- `JourneyView`(路由页)— 顶部指标条 + 过滤栏 + episode 时间线;
- `EpisodeCard` — 一个错误 episode(派生自 `buildErrorLifecycles`)的呈现单元;
- `JourneyFilterBar` — 类型 / 文件 / 解决状态过滤;
- `JourneyMetricsBar` — `buildJourneySummary` 指标的学生友好化呈现。

复用:`MessageBubble` 无关;diff 打开复用 `classmate.openDebugNodeDiff` 的
VS Code 原生 diff 编辑器;文件/行跳转复用 answer-reference 的
`openReference` → `showTextDocumentRespectingPanels` 链路。

**面板布局(自上而下)**:

1. **指标条**:总事件数、已解决/未解决错误数、平均修复尝试次数、求助比例
   ——措辞学生化(不出现 lifecycle/签名等内部术语),如「已自己修好 8 个错,
   还有 2 个没解决」。
2. **过滤栏**:事件类型多选(编译错误/编译成功/运行/编辑/求助)、文件下拉、
   「只看未解决」开关。过滤是纯前端状态,不持久化。
3. **episode 时间线**:按时间倒序的 episode 卡列表。**未解决 episode 置顶区**
   + 已解决按日折叠。每张卡:

```
┌───────────────────────────────────────────────┐
│ ✗  expected ';' before ...        main.cpp:12 │ ← 错误签名首条 message + 位置
│   今天 14:32 首次出现 · 编译 3 次后修好          │ ← 生命周期摘要(派生)
│   ├ 14:32 编译失败(2 error)                    │
│   ├ 14:35 编辑了 main.cpp(改 4 行)[看 diff]   │ ← 点击开原生 diff
│   ├ 14:36 求助了 AI(解释错误)      [回顾对话]  │ ← hint_requested,链到聊天
│   └ 14:40 编译成功 ✓                           │
│   [在代码里看] [求提示]                         │ ← 动作区
└───────────────────────────────────────────────┘
```

未解决卡的区别:状态行显示「还没解决」,动作区只有 `[在代码里看] [求提示]`,
不出现「看修复」类内容(没有修复可看,也不能剧透)。

### 4.2 交互流程(文字描述)

- **打开**:sidebar 树标题按钮 / 命令面板 / #13 复习链接跳入 → 面板按分组策略
  落在不盖源码的列;extension 侧取事件→派生→推视图模型→渲染。
- **浏览**:默认 Landing 在「未解决」置顶区;时间线其余部分按日折叠,点击展开。
- **过滤**:过滤栏变更 → webview 本地过滤已推送的视图模型(数据已在手,不
  回 extension 重取);过滤条件不跨会话保留。
- **看 diff**:点 episode 内的编辑条目 → extension 用 before/after 快照开原生
  diff 编辑器(现有 `openDebugNodeDiff` 通路,只读)。
- **跳到代码**:点 `[在代码里看]` → `showTextDocumentRespectingPanels` 打开
  文件并定位到错误行(ADD2 分组,#18 零闪屏)。
- **求提示**:点 `[求提示]` → 聚焦聊天容器,以该 episode 的错误签名与文件位置
  预填一条求助消息(走正常 answer 链路,受提示层级约束);不自动发送,学生
  确认后发出。
- **回顾对话**:点 `[回顾对话]` → 聚焦聊天容器并切到发起该次求助的会话
  (`hint_requested` 事件带 sessionId 可定位)。
- **清除**:面板设置区提供「清除本工作区调试记录」→ 二次确认 →
  `DebugJourneyStore.clear()`(schema §10.5 要求的视图入口)。
- **实时性**:学生继续编译/求助时,新事件经节流后推 sync,时间线增量更新;
  学生正在看历史中段时不强制滚动。

### 4.3 教学体验设计

- **引导节奏**:视图本身**全是被动呈现**——学生主动打开才出现,运行期间不
  弹窗、不闪动、不抢焦点;新事件到达只在未读徽标上 +1(不自动滚动)。「没
  解决」置顶是唯一的主动引导,且它呈现的是学生自己的未完成事实,不是答案。
- **提示层级策略**:面板内**不内嵌任何讲解内容**,只放事实与入口。需要讲解
  时经 `[求提示]` 回到聊天链路,由 answer 链路的既有 4 级提示(方向 → 排查
  步骤 → 局部线索 → 定位实现提示)与 teaching_strategy 约束接管。面板永远
  比聊天「浅一层」:它回答「发生了什么」,不回答「该怎么改」。
- **与「不自动补全/不自动修复」的关系**:
  1. 展示的全部内容(错误、diff、求助记录)是**学生自己行为的事实回放**,
     不含任何生成代码;
  2. diff 视图只读;**不提供「回滚到某一版」按钮**——before/after 快照虽在
     事件里,自动改写学生文件违反边界(若要,也必须显式确认,见开放问题 Q6,
     推荐不做);
  3. `[求提示]` 只预填消息,发送权在学生;
  4. 已解决 episode 展示的「修复」是学生自己写的 after,不是 AI 给的答案。
- **防依赖**:指标条呈现「求助比例」「独立修复率」(analytics 已有)时用
  鼓励性措辞引导学生先想再问,不做惩罚性展示。

### 4.4 与事件 schema 的对接

| 方向 | 事件 | 用途 |
| --- | --- | --- |
| 消费 | `compile_error` / `compile_success` | episode 起止、时间线条目、指标;`fingerprints`(Q2 写时固化)用于归并同一错 |
| 消费 | `code_modified` | episode 内的修复编辑链(`relatedEventIds` 串接)、diff 快照展示 |
| 消费 | `hint_requested` | 求助条目、「回顾对话」定位会话、求助比例统计 |
| 消费 | `run_completed` / `run_error` | 运行条目(含退出码/截断标记/短预览);**生产者来自 #11 Run 面板,落地前渲染层先做类型就绪的占位** |
| 消费 | `ai_answer_outcome`(Q5 待定) | 求助条目旁标注「这次求助解决了/没解决」 |
| 消费 | episode | **派生不落盘**(schema Q1 推荐 A):`buildErrorLifecycles` 现算 |
| 产生 | 无 | 视图只读;`[求提示]` 产生的 `hint_requested` 走聊天既有生产者,非本视图新增 |

数据流:`events.jsonl` → `DebugJourneyStore.getEvents(filter)` →
派生纯函数(lifecycle/summary)→ 节流 → 消息桥 → `JourneyView`。
`runRecordRef` 指向的运行全文不在事件流内;「看完整运行输出」动作(若做)
按引用去 #11 运行历史流读,落到 Run Panel 展示(见开放问题 Q5)。

## 5. #13 Debug Journey 接入 Agent 工作流(设计题)

#13 的原文是设计题:「事件 → Agent 上下文 → 复习入口」。数据层(schema
§10.3)已定调:注入 Agent 的必须是**摘要化 + 预算可控**的派生 digest,整卷
事件流不进提示词。本文设计其前端落点。

### 5.1 呈现形态(三处落点 + 一处可选)

1. **聊天回答内的复习引用链接(主落点,复用现有机制)**:Agent 回答引用学生
   历史(「这个错你这周出现过 3 次」「上次你卡在同一个链接错误」)时,以
   行内链接呈现,复用 `MarkdownRenderer` 的 reference 渲染与 `openReference`
   派发链路,新增一类 reference 目标(`journey` episode / mistake card)。
   点击 → 打开 #12 面板并定位到对应 episode(形成「回答 → 历史证据」闭环)。
2. **聊天欢迎区复习入口**:welcome-card 的 quick prompts 增加一格「复习我
   最近常犯的错」→ 发送一条 summary intent 消息;answer 链路据 digest 生成
   复习性回答(知识点回顾 + 自己历史的实例),回答内嵌第 1 类链接。
3. **重复错误内联提醒条(审慎的主动干预)**:当一次编译错误的指纹命中
   「同一 `(problemKey ?? workspaceId, signatureKey)` 下已有 ≥N 次历史 episode」
   时,ChatView 消息区顶部出现一条可关闭的内联提示:「这个错之前出现过 X
   次,要不要先看看上次的排查过程?」按钮:`[看看历史]`(开 #12 面板)/
   `[直接问 AI]`(预填求助,学生确认才发)。严格按 CLAUDE.md:
   passive-triggered(编译事件触发)、dismissible(可关,本 session 不再
   为该签名弹出)、frequency-limited(每会话全局上限,参数见开放问题 Q4)。
4. **(可选)「已参考你的调试记录」透明条**:当 digest 实际注入某次回答的
   上下文时,回答气泡底部以小字注明「参考了你最近的调试记录 N 条」,可展开
   看摘要。默认推荐做轻量版(只一行小字),见开放问题 Q3。

### 5.2 数据流与事件对接

```
events.jsonl
  → DebugJourneyStore.getEvents
  → digest builder(新增纯函数,输出:最近未解决签名 ≤3 条、高频知识标签、
    求助/修复计数、与当前错误指纹匹配的史迹;硬预算,超出截断)
  → AnswerPromptBuilder 动态段(遵守 answer 链路既有上下文预算纪律,
    不进缓存前缀)
  → 回答文本(模型决定引用史迹)
  → reference 提取/渲染(现有管线 + journey 目标类型)
  → 前端链接 → #12 面板 episode
```

| 方向 | 事件 | 用途 |
| --- | --- | --- |
| 消费 | `compile_error`(fingerprints) | 当前错误与历史同一错匹配(fuzzy `signatureKey`);digest 的未解决签名来源 |
| 消费 | `code_modified` / lifecycle | 「上次怎么修好的」史迹摘要;独立修复率 |
| 消费 | `hint_requested` | 求助比例、重复求助同一知识点判定 |
| 消费 | `ai_answer_outcome`(Q5) | 复盘「这次求助有没有解决」——若 Q5 定 B(暂缓),digest 退化为只用求助侧信号,复习链接文案不写解决状态 |
| 产生 | 无新类型 | 提醒条点 `[直接问 AI]` 走既有 `hint_requested` 生产者 |

### 5.3 教学体验设计

- **引导节奏**:三处落点的主动度严格分级——链接(被动,学生点了才走)<
  复习入口(半被动,出现在欢迎区,不打扰)< 提醒条(主动,但频控+可关)。
  主动干预只有提醒条一档,且触发条件挂在「学生自己的历史重复」这一客观
  事实上,不是模型心血来潮。
- **提示层级策略**:digest 只含**错误签名、次数、知识标签、解决状态**等
  元信息,**不含修复代码、不含答案要点**——注入让 Agent「知道你卡过」,
  回答仍走既有 4 级提示与 teaching_strategy(#30 修复后,索要完整代码不
  直接答应)。复习性回答(summary intent)的呈现顺序:知识点回顾 → 学生
  自己的历史实例链接 → 「再试一次」引导;不直接陈列修复 diff(那是 #14
  复习模式里学生主动展开才看的内容)。
- **与「不自动补全/不自动修复」的关系**:#13 全链路**不产生任何代码编辑
  动作**——它只改变 Agent 回答的事实依据与前端链接。复习链接打开的是只读
  历史视图;提醒条两个按钮一个开只读面板、一个预填消息(发送权在学生)。
- **措辞纪律**:所有面向学生的复习文案不出现内部术语(签名/指纹/digest/
  episode 等),遵守与更正通道相同的学生安全措辞标准。

## 6. #14 错题本

### 6.1 呈现形态

**容器:与 #12 同一个 WebviewPanel 的第二页签「错题本」**(route `journey`
内嵌 tab:`时间线 | 错题本`)。理由:同一 store、同一派生层、同一面板分组
与生命周期,学生心智上「我的调试记录」是一个地方;独立面板会让三个大屏
(Chat/Run/Journey)变四个。是否拆独立 route 见开放问题 Q2。

**新建组件**:

- `MistakeBookTab` — 页签容器:顶部分组/排序栏 + 卡片列表;
- `MistakeCard` — 错题卡(复习模式的核心交互单元);
- `VersionChainBadge` — 「第 N 次犯」版本链徽章;
- 导出与清除走面板设置区(与 #12 共用)。

**卡片结构**(数据源:`mergeAndSortKnowledgeCards` + lifecycle 版本链):

```
┌───────────────────────────────────────────────┐
│ 未解决·第 3 次犯   指针与地址传递                │ ← 状态徽章 + 知识标签标题
│ 最近:今天 14:32 · 本题累计 3 次                 │
│ ┌ 复习模式 ────────────────────────────────┐  │
│ │ 现象:expected ';' before '}' ...         │  │ ← 第一档:默认只显示这些
│ │ [先自己想想:这通常在说什么?]              │  │
│ │   ↓ 点击展开                              │  │
│ │ 常见原因 / 检查方法(知识库概念)           │  │ ← 第二档:解析
│ │   ↓ 再点击展开                            │  │
│ │ 我上次的改法:[diff 1] [diff 2]           │  │ ← 第三档:自己的修复样例
│ └──────────────────────────────────────────┘  │
│ [在代码里看] [求提示]                           │
└───────────────────────────────────────────────┘
```

- **分组与排序**:分组维度默认「知识标签」;`problemKey` 规则未定(schema
  Q4 推荐 A)前,「按题目」分组 UI 先隐藏或退化为按工作区(现状),规则
  落地后开启。排序沿用 `sortKnowledgeCards`(未解决 > 频率 > 平均尝试 >
  最近)。
- **去重呈现**:同一错只出一张卡(fuzzy `signatureKey`);修复样例按
  `makeFixDedupKey` 去重后最多展示 3 条(现有常量),版本链徽章呈现
  「第 N 次犯」(同一 `(problemKey ?? workspaceId, signatureKey)` 下按
  `firstSeenAt` 排序的 lifecycle 序号)。
- **导出**:页签内保留「导出错题本 Markdown」按钮 → 现有
  `classmate.exportDebugNotebook` 通路(`buildNotebookInput` → LLM 生成,
  无 key/失败退化确定性模板;`showSaveDialog` 用户自选位置)。导出内容
  脱敏(绝对路径→工作区相对路径)随 schema Q7 倾向执行,开关见开放问题 Q7。

### 6.2 交互流程(文字描述)

- **进入**:打开 #12 面板 → 切到「错题本」页签;或从 #13 复习链接直达某张卡。
- **浏览**:默认按排序规则列表;分组切换即时生效(视图模型已含全部卡)。
- **复习(核心)**:卡片三档渐进展开——默认只见「现象+知识标签」→ 学生先
  回忆,点「先自己想想」→ 展开常见原因/检查方法 → 仍需要才展开自己上次的
  修复 diff。每档展开是学生的显式动作,无定时器、无自动展开。
- **行动**:`[在代码里看]` 跳源码(ADD2 链路);`[求提示]` 同 #12(预填
  求助,学生确认发出);解决状态随新事件自动更新(未解决→已解决的卡片
  变化在下一次 sync 体现,不弹通知)。
- **导出/清除**:见上;两动作都有二次确认或原生保存弹窗兜底。

### 6.3 教学体验设计

- **引导节奏**:错题本是**学生主动进入的复习空间**,零主动推送;唯一入口
  型引导来自 #13(欢迎区入口与频控提醒条)。卡片默认折叠解析,把「先回忆」
  设计成阻力最小的路径(第一档信息足够引发回忆,展开需要一次点击)。
- **提示层级策略**:三档展开就是提示层级在复习场景的映射——现象(识别层)
  → 原因/检查方法(理解层,来自课程级知识库概念,非本题答案)→ 自己的
  修复样例(证据层,学生自己写过的代码)。知识库的 `correctExample` 是
  概念通用示例,与当前题目解无关,展示不越界。
- **与「不自动补全/不自动修复」的关系**:
  1. 错题本**全部是派生展示**:错误是学生编译出来的,修复 diff 是学生自己
     改的,知识库内容是预置课程资产;没有任何「AI 替你改」的动作;
  2. 修复样例 diff 只读展示,不提供「应用到当前文件」(同 #12 边界,开放
     问题 Q6 推荐不做);
  3. 导出的 Markdown 走 LLM 时是**聚合后**发送(schema §10.3 通路 a),且
     学生显式触发、自选保存位置。
- **版本链的教学价值**:「第 N 次犯」徽章把重复犯错从隐性变成显性,配合
  「这 3 次之间有什么共同点」的引导文案(静态文案,非 LLM),促成元认知;
  不做分数化/排名化展示。

### 6.4 与事件 schema 的对接

| 方向 | 事件 | 用途 |
| --- | --- | --- |
| 消费 | `compile_error`(parsedErrors + fingerprints) | 归卡(`knowledge` 模式 signatureKey)、去重(fuzzy)、版本链分组键 |
| 消费 | `code_modified` | 修复样例(before/after/diff,16KB 截断沿用);`resolvingEditId` 串版本链 |
| 消费 | `hint_requested` | 卡片的求助比例呈现(schema §7 消费者的「#14 求助比例统计」) |
| 消费 | episode / lifecycle | 派生(`buildErrorLifecycles`),版本链 = 同键 lifecycle 序列 |
| 消费 | `problemKey`(信封字段) | 题目级聚合键;规则未定前缺省,聚合退化为按工作区(schema Q4) |
| 产生 | 无 | 导出 LLM 调用不落事件流(现状保持);复习展开等纯 UI 状态不落盘 |

数据流与 #12 共用同一条 store → 派生 → 消息桥通路;视图模型一次推送同时
含时间线与卡片两个页签的数据,页签切换纯前端。

## 7. 分期落地建议

| 期 | 内容 | 依赖 | 备注 |
| --- | --- | --- | --- |
| 1(#12a) | v2 信封落地(schemaVersion/relatedEventIds/fingerprints 写时固化,schema Q2)+ store append 改 O(1) 追加(schema §2 缺口 7,#12 高频写入前顺手改)+ route 注入机制泛化 + `journey` 面板骨架 + episode 时间线(编译/编辑/求助三类)+ 清除入口 | 无(panelGrouping 注册表已随 B1 合入) | 面板先行可独立验收;run 条目渲染类型就绪、无数据时空态 |
| 2(#14a) | 错题本页签 + 卡片三档复习模式 + 版本链徽章 + 导出按钮接通现有通路 | 期 1(面板与数据通路) | `problemKey` 未定,分组 UI 先按知识标签/工作区 |
| 3(#12b) | `run_completed`/`run_error` 条目渲染 + `runRecordRef` 跳 Run Panel | B2 `feat/run-panel`(#11 生产者落地) | 与期 2 可并行,不同文件 |
| 4(#13) | digest builder(纯函数)+ answer 链路注入(预算纪律)+ journey 类 reference 渲染 + 欢迎区复习入口 + 重复错误提醒条(频控) | 期 1(面板落点);schema Q5(`ai_answer_outcome`)需拍板——定 B 则复盘信号降级 | 前端工作量小,重头在 digest 预算与提示词纪律 |
| 5(#14b) | `problemKey` 规则落地后的按题目分组 UI + 版本链按题收口 | schema Q4 规则拍板、写入侧生产者 | 纯前端跟进,schema 已留字段 |

期 1→2 是主线(学生可见价值最快);期 4 依赖的拍板项最多,排最后但设计
已在本文固化;期 3 视 B2 进度插入。

## 8. 开放问题(需用户拍板)

| # | 问题 | 候选 | 推荐 |
| --- | --- | --- | --- |
| Q1 | sidebar Debug Journey 树在 #12 大屏落地后如何处置? | A 保留收窄为「最近+未解决」入口 / B 整体下线,只留大屏 | **A**:树做摘要是原生组件零成本,下线会损失 sidebar 一眼可见性;B 需连 `#16` 状态机 when 子句一起改 |
| Q2 | #14 错题本放 #12 面板页签还是独立 route? | A 同面板第二页签 / B 独立 route 独立面板 | **A**:同 store 同派生层,大屏面板总量可控(Chat/Run/Journey 三个);分化确实出现时再拆(bundle 共享,拆成本低) |
| Q3 | #13「已参考你的调试记录」透明条做不做? | A 轻量版(气泡底一行小字,可展开摘要)/ B 不做 / C 设置项控制 | 倾向 **A**:digest 注入是后台行为,给学生最低限度的可见性;措辞学生化后无术语风险 |
| Q4 | #13 重复错误提醒条的频控参数? | 触发阈值 N(历史同错 episode 数)/ 每会话上限 / 同一签名每 session 只弹一次 | **N=3、每会话 ≤3 条、同签名一次**(用户 2026-08-22 拍板);宁可少弹不可打扰(CLAUDE.md 干预纪律) |
| Q5 | #12 面板是否做「看完整运行输出」跳 Run Panel(`runRecordRef` 引用)? | A 做,期 3 随 #11 落地 / B 只展示事件内预览,不跳 | 倾向 **A**:两流职责分开始终成立,跳转让事件流保持摘要化;成本仅一个 openReference 类动作 |
| Q6 | before/after 快照是否提供「回滚到这一版」? | A 不做 / B 做但走显式确认弹窗 | **A**:只读 diff 已满足「看」的需求;自动改写学生文件触碰不自动修复边界,收益不抵风险 |
| Q7 | #14 导出是否提供脱敏开关 UI? | A 默认相对路径、不设开关(schema Q7 倾向)/ B 设置项可选原样导出 | 倾向 **A**:分享给同学/助教是主要场景,相对路径应是无脑默认;原样导出需求出现再加 |
| Q8 | 复习模式三档展开是否跨会话记忆? | A 不记忆,每次进页签全部折叠 / B 记忆每张卡的展开档 | **A**:复习的价值在「重新回忆」,记忆展开会让卡片退化成答案列表 |
| Q9 | `ai_answer_outcome` 若定 B(暂缓),#12 求助条目的「解决状态」标注是否同缓? | A 同缓,只显示求助事实 / B 用 lifecycle 派生近似(求助后该错是否消失) | 倾向 **B**:派生近似零 schema 成本且语义更准确(看结果不看回答);但措辞用「后来编译通过了」而非「解决了」 |
| Q10 | #12 期 1 验收是否要求自建 eval 数据集? | A 纯 UI 功能,单测(派生纯函数已有测试)+ 手动验收即可 / B 按评测规范自建数据集 | 倾向 **A**:本功能无 LLM 通路(除既有导出),风险面在 UI 与派生层,单测+人工面板走查足够;#13  digest 注入期再上 eval |
