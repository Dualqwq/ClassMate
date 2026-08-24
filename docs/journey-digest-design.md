# #13 Debug Journey 历史摘要注入 Agent 上下文(轨 FE2 重做版)

> 状态:已实现(2026-08-24)。范围 = #13「事件 → Agent 上下文」前半;
> 「复习入口」UI(设计稿 §5.1 的三处落点)不在本轨。
> 依据:`docs/frontend-teaching-design.md` §5(数据流与措辞纪律)、
> `docs/event-schema-design.md` §10.3(digest 必须摘要化 + 预算可控)。

## 1. 背景与红线

#13 原文是设计题:「事件 → Agent 上下文 → 复习入口」。本轨把 DebugJourneyStore
里的编译/运行历史与错题模式做**确定性**摘要后注入 answer prompt,使模型能
利用学生的调试历史回答。硬性约束:

- 只做历史摘要,**不摘要对话历史**(另一任务);
- 摘要只进当次请求构造:不改 ChatState、不进会话存储、不产生 UI 消息;
- answer 调用不传 thinkingMode(既有契约不变);
- 块措辞不得含内部术语(信封/清单/digest/episode 等);
- 不动学生代码边界;零新依赖。

## 2. 数据流

```
DebugJourneyStore.getEvents()
  → buildJourneyDigest(events, { currentFilePath })   ← 纯函数,src/chat/journeyDigestBuilder.ts
      内部复用 buildJourneyViewModel(FE1/FE3 口径:指纹折叠、解决判定、
      deriveProblemKey 题目归并 main.cpp↔main.exe)
  → ClassMateGraphServices.journeyDigestProvider(extension.ts 闭包:
      classmate.journeyDigest.enabled 开关 + store 取数)
  → ClassMateGraphRunner._buildAnswerPrompt(异常降级为不注入)
  → AnswerPromptBuilder input.journeyDigestContext(system 独立块)
```

runner 不 import vscode、不知道配置开关存在——开关在扩展层闭包里读,
provider 返回 undefined 即整块不出现。这与 coursewareService 的可选注入同构。

## 3. 摘要内容与形态(≤2000 字符)

块结构(全部确定性生成,无 LLM 参与):

```
=== Student debugging history digest ===
<历史定位声明:可能过时/已修复;可主动引用但不得虚构;一切以当前加载文件为准>
Unresolved compile errors:
- main.cpp:12 变量/函数未声明 [编译错误]        ← 文件:行号 + 概念标签(errorKnowledgeMap 标题)+ 级别
Unresolved run errors:
- 运行出错：非法内存访问(段错误)(退出码 139) [main.exe]   ← RUN_ERROR_KIND_LABELS 学生化文案
Recurring mistake patterns:
- 变量/函数未声明 ×3(1 次未解决)               ← 错题卡去重标签 + 出现次数(mergeAndSortKnowledgeCards 口径)
```

设计取舍:

- **复用派生口径而非另造**:解决判定、签名折叠、题目归并全部沿用
  `buildJourneyViewModel`,保证摘要与学生面板看到的事实一致(面板说已解决、
  模型却说还有个未解决错,是信任事故)。代价:重复同签名错误在上游会折叠成
  一个 episode(错题卡 ×N),时间线每签名一行——这是 FE1 的既定语义。
- **概念标签优先走 errorKnowledgeMap 概念标题**(中文,如「变量/函数未声明」),
  不命中 pattern 时退回截断到 80 字符的原始 message。
- **不含修复代码、不含答案要点**:遵守设计稿 §5.3,digest 只给元信息,
  回答仍走 4 级提示与 teaching_strategy。
- **空数据返回 ''**,prompt 构造端保证完全不注入占位块(区别于课件块的
  `[No imported courseware context...]` 占位符形态)。

## 4. 预算纪律与相关度截断

- 默认上限 `JOURNEY_DIGEST_MAX_CHARS = 2000`(标题+声明+节标题+条目全部计入;
  首版漏计节标题会导致超预算承诺,已修)。
- 相关度分级:**当前打开文件(problemKey 相同)> 其余**;同级内按新近度倒序。
  problemKey 由 `deriveProblemKey` 派生(main.cpp 与 main.exe 归并为同一题,
  编译错误与运行错误因此能挂到同一「当前文件」下)。
- 截断为贪心装填:按相关度序逐条尝试,放不下先跳过继续试更短的条目;
  每节另有条数兜底上限(编译/运行/错题各 5 条),防单节独大。

## 5. 注入位置

`answerPromptBuilder` 在课件上下文块之后、Answer plan 块之前插入独立 system
消息。该区域已是每轮变化的动态尾部,不侵蚀 DeepSeek prefix cache 的稳定前缀;
digest 内容本身逐轮也可能变化(新编译事件到达),放尾部符合既有布局原则。

## 6. 测试与验证口径

- `journeyDigestBuilder.test.ts` 9 条:各事件类型呈现、空数据 ''、已解决不进
  未解决清单、措辞无内部术语、相关度排序、字符预算截断(总长 ≤ 上限)、节上限。
- `answerPromptBuilder.test.ts` 新增 3 条:有摘要时独立 system 块存在且位置
  正确(课件上下文之后、答案计划之前);undefined / 空白串均整块不出现。
- 全量 `npm run test`:709 passing / 1 pending / exit 0(基线 697 + 新增 12)。
- 配置开关关闭 → provider 返回 undefined → prompt 无该块(由闭包逻辑保证,
  单测覆盖的是 prompt 端两种输入形态)。

## 7. 遗留问题

1. **复习入口 UI 是 #13 另一半**(设计稿 §5.1 三处落点:回答内复习引用链接、
   欢迎区复习入口、重复错误提醒条),建议另立微轨,依赖本轨的 digest 与
   MarkdownRenderer reference 链路。
2. 设计稿 §5.2 提到的「与当前错误指纹匹配的史迹」「求助/修复计数」未纳入
   本版 digest(当前以 problemKey 相关度近似「与当前错误相关」);若复习入口
   轨需要,可在 builder 里加 fingerprint 匹配段,纯增量。
3. 「已参考你的调试记录」透明条(Q3 可选)未做;digest 不产生任何 UI 消息,
   若要做需在 graph state 里记录本轮是否实际注入。
4. 头文件错误的 problemKey 会落到头文件名(b.h ≠ main),沿用 FE1 已知近似。
