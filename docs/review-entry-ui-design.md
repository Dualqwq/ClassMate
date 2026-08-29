# #13 后半「复习入口 UI」设计计划

> 状态:待用户拍板(2026-08-28 产出,worktree `docs/review-entry-ui-plan`)。
> 依据:`docs/frontend-teaching-design.md` §5(#13 三处落点与教学体验设计,已定稿)、
> `docs/journey-digest-design.md` §7(FE2 遗留清单)、`CLAUDE.md` 教学边界
> (不自动补全/不自动修复;一切自动干预 passive-triggered、dismissible、
> frequency-limited)、AGENTS.md 验证口径。
> 范围:**纯设计计划,不含实现代码**。只覆盖「学生主动复习错题的入口与
> 复习体验形态」;回答内复习引用链接(设计稿 §5.1 落点 1)与重复错误提醒条
> (落点 3)因契约面与工作量独立,列为后续轨(§3.5)。

## 1. 目标与用户场景

### 1.1 目标

#13 = Debug Journey 历史摘要与复习。前半(FE2,已合入 `770254f`)是
**被动注入**:`buildJourneyDigest`(src/chat/journeyDigestBuilder.ts:151)
把未解决编译错误、未解决运行错误、错题模式做确定性摘要(≤2000 字符),
经 `answerPromptBuilder`(src/prompts/answerPromptBuilder.ts:236-244)注入
answer prompt 的 system 区——学生对此**无感知**。

后半是**主动行为**:给学生一个看得见、用得上的复习入口。CHANGELOG 已
记录遗留:「复习入口 UI(#13 另一半)」。当前学生唯一能主动接触错题历史
的路径是打开 Journey 面板 → 切「错题本」页签自己翻卡片;没有任何机制
引导或承载一次完整的复习过程。

### 1.2 与 FE2 摘要注入的关系与边界

| | FE2 摘要注入(已合入) | 复习入口(本设计) |
| --- | --- | --- |
| 触发方 | 系统(每次 answer 自动) | 学生(显式点击) |
| 消费者 | LLM(模型上下文) | 学生(屏幕上的教学交互) |
| 内容 | 元信息(签名/次数/标签/解决态),不含修复代码 | 知识回顾 + 学生自己的历史实例 + 引导再练 |
| 教学边界 | 回答仍走 4 级提示与 teaching_strategy | 面板只放事实与入口,讲解回聊天链路 |
| 可见性 | 零 UI(可选透明条未做) | 本设计的全部产出 |

一句话边界:**注入让 AI「知道你卡过」,复习入口让学生「主动复盘」**。
两者共享同一份派生事实(`buildJourneyViewModel` → digest 与错题卡同源),
不另造数据口径——「面板说已解决、模型却说未解决」是信任事故
(journey-digest-design.md §3 已确立此原则,本设计延续)。

### 1.3 用户场景(C/C++ 初学者)

1. **课后复盘**:学生做完一道题,想回顾「这周我到底错在哪、哪些反复犯」。
   期望:有人把我反复出错的几个知识点串起来讲一遍,而不是自己翻卡片。
2. **考前自测**:考试前想快速过一遍错题。期望:一张一张过,先看现象自己
   想,想不起来再看解析——错题卡三档展开正是为此设计,但缺「逐张过」的
   会话感(顺序、进度、「过完了」的完结)。
3. **新会话冷启动**:打开 VS Code 不知道该问什么,聊天欢迎卡出现
   「复习我最近常犯的错」→ 一键进入复习。
4. **顺路引导**(落点 3,独立轨):学生刚又犯了一次老错,AI 频控提醒
   「这个错之前出现过 3 次」。参数已拍板(N=3、每会话 ≤3 条、同签名一次),
   本轨不做,见 §3.5。

## 2. 现状盘点

### 2.1 已有资产(全部经代码确认)

| 资产 | 位置 | 现状要点 |
| --- | --- | --- |
| Journey 大屏面板 | src/ui/JourneyPanel.ts:34 | route `journey`,与 Chat/Run 同级;`classmate.debugJourney` 命令 + sidebar 树标题按钮(package.json view/title navigation@0)两个入口;单例,reveal 不重建 |
| 两页签容器 | webview/src/journey/JourneyView.tsx:73-90 | 「时间线 \| 错题本」页签切换纯前端;一次 `journey:sync` 推全量视图模型(两个页签共用) |
| 错题卡三档渐进展开 | webview/src/journey/MistakeCard.tsx:29-134 | stage 0 现象 → 1 常见原因/检查方法 → 2 自己的修复 diff(只读);展开不跨会话记忆(设计稿 Q8=A);**这就是复习模式的核心交互,已落地** |
| 错题本分组/排序 | src/journey/journeyFilters.ts:195-258 | `sortMistakeCards`(recommended=视图模型既有序 / recent);`groupMistakeCards`(tag / problemKey) |
| 错题卡排序口径 | src/debug/knowledgeCard.ts:354-367 | `sortKnowledgeCards`:未解决 > 频率 > 平均尝试 > 最近(教学优先级既定) |
| 过滤交互 | src/journey/journeyFilters.ts:36-57 | 类型/级别/run 分类/文件/只看未解决,纯前端状态不持久化 |
| run_error 学生标记已解决 | src/journey/journeyService.ts:147-154 | `journey:markResolved/markUnresolved` → store 落盘 → sync 广播;解决权完全在学生 |
| 导出错题本 | webview/src/journey/MistakeBookTab.tsx:51-57 | 「导出错题本」按钮 → `classmate.exportDebugNotebook` 既有通路 |
| FE2 digest 注入 | src/chat/journeyDigestBuilder.ts → src/prompts/answerPromptBuilder.ts:236 | 被动上下文;graph runner 1497-1510 接线,extension.ts:1083-1094 provider(配置 `classmate.journeyDigest.enabled`,默认开) |
| [求提示] 预填链路 | src/journey/journeyService.ts:215-221 | `journey:requestHint` → `ChatSession.prefillInputDraft`(src/chat/ChatSession.ts:733-737,权威草稿广播)→ `classmate.openChatPanel`;**只预填不发送,发送权在学生** |
| 欢迎卡 quick prompts | webview/src/App.tsx:12-37, 486-506 | 4 条快捷提问;**只在空会话(`state.messages.length === 0`)显示**;点击 `chooseQuickPrompt` 覆盖输入框(显式动作) |
| summary 意图 | src/prompts/intentRouter.ts:79-81 | `summary` intent → `mistake_summary` requestType(family-locked,taskRegistry.ts:99-104,「按照错题总结结构输出 Markdown」) |
| 消息契约 | src/chat/types.ts:214-237 | Journey 消息独立 union(webview→ext 8 种 / ext→webview 2 种);新消息先入此文件 |

### 2.2 缺口

1. **没有任何「开始复习」的入口**:欢迎卡 4 条 quick prompt 无复习格;
   错题本页签只有列表浏览,无会话化的「逐张过 + 进度」体验。
2. **回答内复习引用链接**(设计稿 §5.1 落点 1)未做:
   `answerReferenceWireSchema`(src/chat/answerReferenceSchema.ts:6-13)只有
   文件路径/符号/行号,无 journey 目标类型;面板 `openJourneyPanel` 也不支持
   deep-link 定位到某张卡。
3. **重复错误提醒条**(落点 3)未做。
4. digest 无复习专用形态:按「当前文件 > 同题 > 其余」相关度排序
   (journeyDigestBuilder.ts:155-168),复习场景没有「当前文件」。

### 2.3 关键契约注意点(设计必须绕开的坑)

- **`HINT_INTENTS` 含 `summary`**(src/chat/ChatSession.ts:44-51):带显式
  intent 发送的消息会记 `hint_requested` 事件(ChatSession.ts:1237-1238
  以 intent 为门槛),进入求助比例指标。**复习不是求助**——若复习指令带
  `summary` intent 走 `startIntentResponse`,会污染求助比例/独立修复率。
  详见 §4.4。
- **欢迎卡仅空会话可见**(App.tsx:486):欢迎区入口天然是「低频惊喜」而
  非常驻入口,必须有常驻入口补偿(方案 A2)。
- **`inputDraft` 是 composer 唯一事实源**(AGENTS.md 契约):一切预填必须走
  `prefillInputDraft` 权威草稿广播,前端 suppress 逻辑自动让位给学生正在
  输入的内容——既有链路已处理,新入口不得绕开。

## 3. 入口与形态方案

### 3.1 方案 A:聊天复习指令入口(双入口汇入同一预填流)

**形态**:三个入口,全部汇入「预填一条复习指令草稿 → 学生确认发送 →
answer 链路(digest 已被 FE2 被动注入)→ 复习性回答」。

- **A1 欢迎卡第 5 格**(App.tsx QUICK_PROMPTS 追加):
  标题「复习我最近常犯的错」/ 描述「把反复出错的知识点串起来讲一遍」/
  预填文案见 §4.4。纯 webview 本地改动,零新消息。仅空会话可见(已知局限,
  由 A2 补偿)。
- **A2 错题本页签「让 AI 带我复盘」按钮**(MistakeBookTab.tsx 过滤栏,
  与「导出错题本」并排):点击 → 新消息 `journey:requestReview` →
  JourneyService 预填复习草稿 + `classmate.openChatPanel` 聚焦聊天。
  **常驻入口**,与 [求提示] 同底座(JourneyService.ts:215-221 的
  requestHint 模式),只是预填文案不同、语义不同(复盘 ≠ 求助)。
- **A3 命令面板 `classmate.reviewMistakes`**(可选):与 A2 同 handler,
  一行命令注册。对初学者不可见,零成本顺手项。

**复习回答的教学形态**(设计稿 §5.3 既定):知识点回顾 → 学生自己的
历史实例 → 「再试一次」引导;不直接陈列修复 diff。这依赖 prompt 端
约束(`mistake_summary` 的 responsePattern + digest 声明「不得虚构」),
不新增 UI 呈现逻辑。

**利**:
- 复用度最高:quick prompt 机制、`prefillInputDraft` 权威草稿链路、
  FE2 digest 注入、`mistake_summary` 意图路由全部现成;
- 教学内容(讲解、串联、个性化归纳)留在聊天链路,受 4 级提示与
  teaching_strategy 约束——符合「面板永远比聊天浅一层」(设计稿 §4.3);
- 主动度 = 半被动(出现在欢迎区/按钮上,不打扰),不触碰干预纪律;
- 新消息契约仅 1 条(`journey:requestReview`),且与既有
  `journey:requestHint` 结构同构。

**弊**:
- 复习内容质量依赖 LLM + digest 预算(≤2000 字符、每节 5 条上限):
  高频多卡学生的复习回答可能只覆盖部分错题;
- 欢迎卡入口仅空会话可见;
- 无确定性进度感(「过完了」的完结体验缺失)。

### 3.2 方案 B:错题本页签内「逐张复习」确定性队列

**形态**:错题本页签过滤栏加「逐张复习」按钮 → 页签内切换到复习视图:
一次只显示一张卡(队列序 = 视图模型既有序,见 §4.1),复用 MistakeCard
三档展开;卡底部动作区加「下一张」;顶部进度「3 / 8」与「结束复习」。
纯前端状态(页签内局部 state),退出/切页签即复位——延续 Q8=A
「复习状态不跨会话」的既定精神,零落盘、零新消息。

**利**:
- 完全确定性:零 LLM、零 API 成本、零网络依赖;
- 复用 MistakeCard(三档展开就是复习模式核心交互),新代码主要是
  队列状态与进度条;
- 教学边界天然安全:全部内容是学生自己的事实 + 静态知识库概念
  (commonCauses/checkMethod 来自预置课程资产,与本题答案无关);
- 考前自测场景(§1.3 场景 2)体验完整:顺序、进度、完结。

**弊**:
- 讲解深度受限:无「你这三个错都和指针有关」的个性化串联(那需要
  LLM),静态卡片逐张过;
- 与列表浏览的增量价值要靠「强制顺序 + 隐藏其余 + 进度感」论证——
  若学生只是想查某张卡,列表模式仍保留,两模式并存。

### 3.3 方案 C(命令面板)与方案 D(提醒/徽标)

- **C 命令面板独立成入口**:对初学者不可见(他们不知道命令面板),
  单独做无意义;作为 A3 并入方案 A 顺手注册。
- **D 定期提醒/通知**:**不推荐**。通知是主动干预,CLAUDE.md 要求
  passive-triggered、dismissible、frequency-limited;「定期」触发挂在
  时钟而非学生行为上,不满足 passive-triggered。零打扰替代形态
  (sidebar 树/面板 title badge 显示未解决计数)技术上可行
  (TreeView badge API),但属「提示有未解决」而非「复习入口」,
  价值待复习入口上线后用数据验证,首版不做(待拍板 Q8)。

### 3.4 推荐与分期

**推荐:A + B 组合,A 先 B 后**:

| 期 | 内容 | 价值 | 依赖 |
| --- | --- | --- | --- |
| 期 1(方案 A) | 欢迎卡复习格 + `journey:requestReview` 消息 + 错题本「让 AI 带我复盘」按钮 + 命令注册 | 学生第一次有「让 AI 带我复盘」的一键路径;LLM 串联讲解(个性化) | FE2 已合入,零前置 |
| 期 2(方案 B) | 错题本「逐张复习」模式 + `buildReviewSession` 纯函数 | 确定性自测体验,进度与完结感 | 期 1 无依赖,可独立并行 |

理由:A 承载「讲解与串联」(LLM 擅长、聊天链路教学约束完备),B 承载
「自测与过卡」(确定性、零成本);两者共用错题卡数据与三档交互,互不
重复造轮子。单独只做 A 则无完结感,单独只做 B 则无个性化讲解——组合
才覆盖 §1.3 场景 1 + 2。

### 3.5 明确不在本轨的相邻工作(后续独立轨)

1. **落点 1 回答内复习引用链接**:需扩 `answerReferenceWireSchema`
   (journey 目标类型,如 episode/card id)+ sanitizer 白名单 +
   `linkifyAnswer`/MarkdownRenderer 渲染 + `openJourneyPanel` 支持
   deep-link 定位——横跨 chat 引用管线与 journey 面板两个契约面,
   且引用提取 LLM 调用有额外失败面。工作量约等于本轨期 1,独立成轨。
2. **落点 3 重复错误提醒条**:需 ChatView 消息区内联 UI + 频控状态机
   (N=3、每会话 ≤3 条、同签名一次,已拍板)+ compile_error 事件触发
   通路。涉及 ChatState 展示面,独立成轨。
3. **「已参考你的调试记录」透明条**(设计稿 Q3,倾向轻量版):需 graph
   state 记录本轮是否实际注入 digest。依赖少但纯增益型,排最后。

## 4. 数据与派生设计

### 4.1 复习内容来源与排序

- **来源**:`JourneyViewModel.mistakeCards`
  (src/journey/journeyViewModel.ts:542-565)——已是
  `buildKnowledgeCardsFromEvents` → `mergeAndSortKnowledgeCards` 的产物
  (knowledgeCard.ts:354-374),含 tag/title/现象/常见原因/检查方法/
  修复样例/频率/解决计数/problemKey 全部复习所需字段。
- **排序**:首版**直接沿用视图模型既有序**(未解决 > 频率 > 平均尝试 >
  最近),不新造排序口径。理由:错题本列表的「推荐序」与复习队列的
  教学优先级是同一个问题(最该先复习的 = 未解决且高频的),
  `sortMistakeCards(cards, 'recent')` 的「最近出现优先」继续作为学生
  可选的另一种浏览序,不进队列。
- **期 2 新增轻量纯函数** `buildReviewSession`(src/journey/
  journeyFilters.ts 与既有过滤纯函数同层,可 mocha 单测):

```ts
// 草案签名(实施轨定稿)
export interface ReviewSession {
    cards: MistakeCardVM[];   // 队列(既有序,可选上限切片)
    total: number;            // 队列总张数(进度分母)
}
export function buildReviewSession(
    cards: MistakeCardVM[],
    options?: { limit?: number }   // 默认全部;上限防长列表刷屏(待拍板 Q4)
): ReviewSession;
```

  纯函数只做切片与计数,不做重排——排序权留在
  `mergeAndSortKnowledgeCards`,避免两套优先级漂移
  (与 FE2「复用派生口径而非另造」同一纪律)。

### 4.2 digest 复用性评估(FE2 口径,零改动可直接复用)

- 复习指令发出的消息走正常 answer 链路 → graph runner 自动调用
  `journeyDigestProvider`(ClassMateGraphRunner.ts:1497-1510)→ digest
  已在上下文里,**复习回答天然有事实依据,零接线工作**。
- 相关度排序在复习场景的退化:`currentFilePath` 来自当前 active editor;
  复习时若学生恰好开着某文件,digest 会把该文件的错顶前——**无害**
  (复习回答先讲眼前的错反而合理);若要「纯全量复习」,可在复习指令
  handler 里不传当前文件,但首版**不做**这种特判(保持链路单一)。
- 预算与条数上限(2000 字符/每节 5 条)对复习是否够用:列为待拍板 Q5,
  默认**不放宽**——「模型引用的事实与学生面板看到的一致」是信任底线,
  放宽预算意味着模型知道得比学生多,反而破坏对称;不够时优先让学生
  分话题再问一次,而非加大注入。

### 4.3 复习回答的呈现纪律(prompt 端约束,非 UI)

复习指令若被路由为 `mistake_summary`(intentRouter.ts:79-81),其
responsePattern「按照错题总结结构输出 Markdown」与设计稿 §5.3 的
复习呈现顺序(知识点回顾 → 历史实例 → 再试一次引导)方向一致。
实施轨需验证一件事:`mistake_summary` 走 answer 链路时 teaching_strategy
与 4 级提示约束是否同样生效(理论上 actionType: 'answer' 即生效,
taskRegistry.ts:99-104)。若发现复习回答出现「直接陈列完整修复代码」,
优先在 prompt/responsePattern 端修,不在 UI 端遮蔽。

### 4.4 复习指令的事件记录口径(不污染求助指标)

**关键决策:复习指令不带显式 intent,以普通草稿预填 + 学生手动发送
的方式进链路。**

- 预填草稿(方案 A1/A2)→ 学生按 Enter → `sendMessage`(无 intent)→
  `_recordHintRequested` 以 intent 为门槛(ChatSession.ts:1237-1238),
  **不记 `hint_requested`** → 求助比例/独立修复率不受污染。
- intentRouter 对无显式 intent 的文本走 `inferFromText`,「复盘/错题/
  复习」类文案大概率路由到 `mistake_summary` 或相近 requestType——
  路由结果只影响回答组织方式,不影响事件流,可接受。
- 反例(不采用):复用 `summary` intent 走 `startIntentResponse`
  (ChatSession.ts:1260)——语义上「按钮触发的指令消息」会被记为
  `hint_requested`(HINT_INTENTS 含 summary),把复习计入求助,
  指标失真。若未来需要意图级锁定(确保一定走 mistake_summary),
  正确做法是新增 `review` intent 且**不加入 HINT_INTENTS**
  (待拍板 Q2,默认不带)。

**预填文案草案**(A1 与 A2 共用,措辞学生化、无内部术语、先想后看):

> 帮我复盘一下最近的错题:把我反复出错的几个知识点串起来讲一遍。
> 每个先说我当时错在哪,再讲怎么检查,最后给我一个可以自己再试一次的
> 小方向就好,先不要给完整代码。

## 5. 消息契约草案

按 AGENTS.md 约定:任何新 webview↔extension 消息**先入
`src/chat/types.ts`**。本轨契约变更极小:

```ts
// src/chat/types.ts — JourneyWebviewToExtensionMessage 追加一条:

    /**
     * 错题本「让 AI 带我复盘」(#13 后半):预填一条复习指令草稿并聚焦
     * 聊天容器。与 journey:requestHint 同底座(prefillInputDraft +
     * openChatPanel,只预填不发送,发送权在学生),但语义独立:
     * 复习是主动复盘,不是卡住求助——预填文案与教学期望均不同,
     * 不复用 requestHint 以免语义混载。
     */
    | { type: 'journey:requestReview' };
```

- **不新增** extension→webview 消息:预填走既有权威草稿
  `stateSync`(includeDraft: true)广播,聊天前端 composer 契约
  (composerDraftContract)已处理「学生正在打字时跳过覆盖」。
- **handler 落点**:`JourneyService.handleMessage` 加一个 case
  (src/journey/journeyService.ts:88-115 的 switch),实现与
  `requestHint`(journeyService.ts:215-221)平行:`prefillInputDraft`
  + `classmate.openChatPanel`。
- **期 2(方案 B)零新消息**:逐张复习是错题本页签内局部 React state,
  不回传 extension(不落盘,见 §4.1)。
- **A1 欢迎卡 / A3 命令**:零消息(quick prompt 是 webview 本地常量;
  命令是 extension 侧注册)。

## 6. 实施切片

每片一个分支一个主题,从 `after-0803` 切出,`--ff-only` 合入后删分支;
完成后留在各自 worktree 待人工审核(AGENTS.md 多 Agent 约定)。

| 切片 | 分支名 | 内容 | 规模预估 |
| --- | --- | --- | --- |
| 1 | `feat/review-entry-chat` | ① `src/chat/types.ts` 加 `journey:requestReview`;② JourneyService handler + 预填文案常量;③ MistakeBookTab 过滤栏「让 AI 带我复盘」按钮;④ App.tsx QUICK_PROMPTS 第 5 格;⑤ package.json 注册 `classmate.reviewMistakes` 命令(contributes + handler 走同一预填);⑥ CHANGELOG 一行 | 小(约 6 文件,核心逻辑 < 60 行) |
| 2 | `feat/review-queue` | ① `journeyFilters.ts` 加 `buildReviewSession` 纯函数;② MistakeBookTab 「逐张复习」按钮 + 页签内复习视图(单卡 + 进度 + 下一张/结束);③ classmate.css 复习视图样式(尽量复用既有卡片样式);④ 单测 + CHANGELOG | 中(纯前端 + 纯函数) |

切片间无代码依赖(不同文件面),可并行两个 worktree;建议串行验收
(期 1 先过人工审核门 G1——前端轨须过人工审核,AGENTS.md 验证口径)。

**验收口径**:每片 `npm run test` 全绿(exit 0);跑全量前先 `rm -rf out`
(AGENTS.md 教训①);期 1 含 LLM 通路,须按
`ClassMate测试方法指南.md` 自建小数据集做一次 live eval 人工判卷
(见 §7)。

## 7. 测试计划

### 7.1 单元测试(mocha,既有风格)

- **journeyFilters.test.ts 追加**(期 2):`buildReviewSession`——
  空卡输入返回空队列;顺序与输入序一致(不重排);limit 切片;
  total 计数;`cards` 数组为浅拷贝(调用方改队列不影响原视图模型)。
- **journeyService.test.ts 追加**(期 1):`journey:requestReview` →
  chatSession.prefillInputDraft 被调用且文本含「复盘」;**不**触发
  addUserMessage/startAssistantMessage(只预填不发送);
  `classmate.openChatPanel` 被执行;无 chatSession 注入时不抛错
  (与 requestHint 同降级)。
- **契约回归**:types.ts union 变更后,
  `vscodeApi.ts` 的 Any* 组合类型编译通过(既有 tsc 编译即覆盖)。

### 7.2 集成测试(vscode-test,journeyPanelCommand.test.ts 风格)

- `classmate.reviewMistakes` 命令注册且可执行(不依赖面板状态);
  命令路径与按钮路径等价(同 handler)。

### 7.3 手动验收清单(webview 走查,`npm run watch:webview` 热更)

1. 空会话:欢迎卡出现第 5 格「复习我最近常犯的错」,点击后输入框被
   预填,焦点在输入框,**未自动发送**;quick-prompts 栅格从 2×2 变
   2×3(或 3+2)不破版。
2. 非空会话:欢迎卡不显示(既有行为不变),从错题本页签「让 AI 带
   我复盘」进入 → 聊天面板打开 + 草稿预填;学生正在输入时点按钮,
   草稿**不覆盖**其输入(composerDraftContract suppress 生效)。
3. 发送复习指令:回答呈现「回顾 → 我当时的错 → 检查方法 → 再试一次
   引导」结构;**不出现完整修复代码陈列**;引用的次数/文件与学生
   面板所见一致(信任一致)。
4. 期 2:错题本「逐张复习」进入后一次一张卡;三档展开默认折叠;
   「下一张」推进;进度计数正确;切到时间线页签再回来,复习进度复位
   (不跨页签保留——与 Q8=A 同精神,待实施时确认复位粒度);
   清除记录(journey:cleared)后复习视图退出到空态。
5. 事件流:发送复习指令后,events.jsonl **无新增 hint_requested**
   (求助指标不受污染——§4.4 的核心断言)。

### 7.4 live eval(期 1,自建数据集)

按 `ClassMate测试方法指南.md` 自建 3–5 个 workspace(mutation 可恢复
变异,制造 2–4 个不同签名的未解决错 + 1 个高频重犯),执行复习指令,
人工判卷:①回答只覆盖 digest 内事实(不虚构历史);②呈现顺序符合
§4.3;③无完整代码泄漏;④对「没有历史」的空 workspace,回答不编造
(digest 为空 → 模型应诚实说明无记录,列入判卷项)。

## 8. 待拍板问题清单

| # | 问题 | 候选 | 默认建议 |
| --- | --- | --- | --- |
| Q1 | 入口组合确认 | A 聊天复习指令 + B 逐张复习两期组合 / 只做 A / 只做 B | **A+B 两期组合**(A 承载讲解串联,B 承载自测完结感;数据同源互不重复) |
| Q2 | 复习指令是否带显式 intent | A 不带(普通草稿发送,零事件副作用)/ B 新增 `review` intent 且不加入 HINT_INTENTS / C 复用 `summary` intent | **A**:零契约变更、不污染求助指标;C 明确否决(summary 在 HINT_INTENTS 内,会记 hint_requested);B 留作意图锁定需求出现时的升级路径 |
| Q3 | 预填文案定稿 | §4.4 草案 / 用户改写 | **采用草案**,实施轨可微调措辞,保持「先不要给完整代码」的边界句 |
| Q4 | 期 2 队列上限 | A 不设上限(全部卡)/ B 默认上限 10 张(可「继续复习」) | **B 上限 10**:防高频学生首屏刷屏与认知过载;超过 10 张时按既有序截取并在进度条显示「前 10 / 共 N」 |
| Q5 | 复习场景 digest 预算是否放宽 | A 不放宽(2000/每节 5 条不变)/ B 复习指令触发放宽(如 4000/10 条) | **A 不放宽**:模型与学生面板看到同一份事实是信任底线;覆盖不足时分话题再问,而非加大注入 |
| Q6 | 复习行为是否落盘(为将来 spaced repetition 铺路) | A 不落盘(纯 UI 状态)/ B 新增 review 事件类型 | **A 不落盘**:延续 Q8=A「复习状态不跨会话」精神;SRS 需要稳定的复习效果数据模型,当前无「记没记住」信号,落盘为时尚早 |
| Q7 | 命令面板入口 `classmate.reviewMistakes` | A 注册 / B 不注册 | **A 注册**:一行 contributes 零成本,顺手补齐高级用户路径 |
| Q8 | 树/面板未解决计数徽标(badge) | A 本轨做 / B 复习入口上线后按数据再议 | **B 再议**:badge 是「提示未解决」不是「复习入口」,价值需入口上线后的使用数据支撑;且树收窄状态(Q1 of 前端设计稿)未完全落地,先不动树 |
| Q9 | 「让 AI 带我复盘」按钮位置 | A 错题本页签过滤栏(与导出并排)/ B Journey 面板 header(两页签共用) | **A 页签过滤栏**:复盘语义只关乎错题本,放 header 会把时间线页签也牵连;与导出按钮并排保持「错题本的动作都在错题本里」 |
| Q10 | 期 2 复习进度是否跨页签保留 | A 切页签即复位 / B 面板存续期内保留(关面板才复位) | **A 复位**:与 Q8=A「重新回忆」的教学理由一致,实现也最简(局部 state);B 的「误切页签丢进度」痛点未证实 |
