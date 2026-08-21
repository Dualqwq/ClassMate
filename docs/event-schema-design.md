# ClassMate 事件 Schema 设计(#12 / #13 / #14 共用数据源)

> 状态:草案,待用户拍板(拍板项见文末「开放问题」)。
> 依据:`0803后要干的事情.md` #12/#13/#14 原文、`plan-todo-priorities-20260820.md` §3.1
> 已拍板表(#12/13/14 行、ADD3 行、grill R2-Q2 行)与 §四 预测 5。
> 拍板口径:**先出事件 schema 设计文档,schema 定了再写码**;#14 错题本导出仅留
> 只读读接口,格式等 #14 立项(grill R2-Q2)。

## 1. 背景与目标

#12(Debug Journey 升级)、#13(Debug Journey 接入 Agent 工作流)、#14(逐工作区
错题本)消费的是**同一份调试历程数据**。本设计的目标是定义一份共用事件 schema:

1. **#12** 需要一个字段足够丰富、可过滤、可还原时间线的事件流,替代当前过于
   简陋的展示;
2. **#13** 需要把事件以**摘要化、预算可控**的形式注入 Agent 上下文(事件 →
   Agent 上下文 → 复习入口);
3. **#14** 需要在事件之上做题目级聚合、错误卡片结构化、去重与版本链;schema
   只保证这些聚合**可确定性派生**,并提供只读读接口。

非目标:错题本自身的持久化格式(#14 立项再定)、运行历史的内部记录格式
(#11 落地时定)、任何写码动作。

## 2. 现状盘点(v1)

现有实现已经是一份 v1 事件 schema,本设计在其上做**增量扩展**而不是重起炉灶。

- 类型定义 `src/debug/types.ts`:5 种事件 `compile_error` / `compile_success` /
  `run_error` / `hint_requested` / `code_modified`,共用信封
  `BaseDebugEvent { id, type, timestamp, sessionId, workspaceId, fileUri? }`。
- 存储 `src/debug/debugJourneyStore.ts`:逐工作区 JSONL
  (`globalStorageUri/debug-journey/<workspaceId>/events.jsonl` + `index.json`),
  上限 2000 条、超限按 10% 批量裁尾,单字段 16KB 截断;globalState 存 50 条
  热缓存与索引副本,存储键自带 `.v1` 后缀。
- 工作区标识 `src/debug/storagePath.ts`:`sha256(workspaceFolders[0].uri.toString())`
  取前 16 hex——hash 输入已是工作区 Uri,与 ADD3 拍板一致(多目录工作区只取
  第一个 folder,见开放问题 Q6)。
- 错误指纹 `src/debug/errorFingerprint.ts`:`normalizeErrorMessage`(小写化、
  引号标识符→`<id>`、数字→`<num>`、空白折叠)+ `ErrorSignature` +
  strict/fuzzy/knowledge 三档 `signaturesMatch` + `signatureKey`。
- 错误生命周期 `src/debug/errorLifecycle.ts`:`buildErrorLifecycles` 由事件流
  派生「出现→(修复编辑)→消失/编译成功」链,前瞻 5 次编译。
- 错题卡片 `src/debug/knowledgeCard.ts`:按知识标签归卡、跨事件合并统计、
  修复样例按归一化 before/after 去重。
- 导出错题本 `src/debug/debugNotebook.ts`(3bacf85):聚合输入 → LLM 生成
  Markdown,失败/无 key 退化确定性模板;`showSaveDialog` 用户自选保存位置
  (extension.ts:719)。

**v1 缺口**(v2 要补的):

1. `run_error` 类型已定义但**没有任何生产者**(运行走集成终端,无输出捕获);
   #11 Run 面板落地后才有真实运行数据。
2. 事件记录**无逐条版本号**,只有存储键带 `.v1`;演进缺抓手。
3. `run_error` 之外没有运行成功/超时/等输入等结果区分。
4. AI 交互只有 `hint_requested` 单侧(求助发出),没有回答侧结果(兜底/更正)。
5. 无题目级标识,聚合只能按工作区/文件维度。
6. `code_modified` 的 `trigger` 定义了 `manual` / `pre_compile` /
   `post_compile_error` 三档,实际只有 `pre_compile` 有生产者(extension.ts:373)。
7. 存储 append 实现为「读全文件 + 整体重写」,非 O(1) 追加——实现债,不影响
   schema,但 #12 高频写入前宜顺手改。

## 3. 事件分类法与逐类字段(v2 草案)

分类轴:**编译 / 运行 / 代码编辑 / AI 交互 / 调试会话**。每类给出字段与生产者
来源;`errorFingerprint` 的复用见 §4。

### 3.1 编译类

| 类型 | 语义 | 关键字段(信封之外) |
| --- | --- | --- |
| `compile_error` | 一次编译失败(含 warning 级诊断) | `stderr`、`parsedErrors: ParsedError[]`、`exitCode`、`durationMs`;v2 新增 `fingerprints?: ErrorSignature[]`(见 §4)、`buildTool?: 'g++' \| 'make'`、`command?: string` |
| `compile_success` | 一次编译成功 | `exitCode`、`durationMs`;v2 新增 `buildTool?`、`outputPath?: string` |

- `buildTool`/`command` 为 #8 make 链路预留(make 场景一次编译涉及多文件,
  `fileUri` 仍为触发文件,逐文件归属看 `parsedErrors[].file`)。
- `parsedErrors` 复用 `src/error/errorParser.ts` 的 `ParsedError`
  (file/line/column/severity/message/code/range),v1 已在用,不动。

### 3.2 运行类

v1 仅有 `run_error` 定义。v2 对齐 #11 已拍板设计(预置 stdin + 管道捕获、
stdout/stderr 64KB 头尾截断持久化、交互程序兜底 grill Q4):

| 类型 | 语义 | 关键字段 |
| --- | --- | --- |
| `run_completed` | 运行结束,退出码 0 | `executablePath`、`exitCode`、`durationMs`、`stdoutBytes`、`stderrBytes`、`stdoutPreview?`、`stderrPreview?`(短预览,≤512 字符)、`truncated: boolean`、`runRecordRef?: RunRecordRef` |
| `run_error` | 运行未正常结束 | 同上,另加 `reason: 'exit_nonzero' \| 'killed' \| 'timeout' \| 'needs_input'`;`needs_input` 对应 grill Q4「程序仍等输入但 stdin 已读完」兜底 |

- `RunRecordRef = { exeKey: string; recordId: string }`:指向 #11 运行历史中
  该次运行的完整记录(逐 exe 一条 JSONL、环形 20 次、64KB 头尾截断,grill
  R2-Q2)。**事件流只存摘要与预览,全文在运行历史流**,避免同一份 stdout
  双写膨胀。引用粒度是否如此见开放问题 Q3。
- `executablePath` 为绝对路径,与 #11 运行历史键(workspaceUri + exe 绝对
  路径)对齐。

### 3.3 代码编辑类

| 类型 | 语义 | 关键字段 |
| --- | --- | --- |
| `code_modified` | 检知到文件内容变化 | `before`、`after`、`diff`、`trigger`、`relatedEventId?`(v2 泛化为 `relatedEventIds?`,见 §9) |

v1 已有,不动;`manual` / `post_compile_error` 生产者何时补(#12 立项)不在
本 schema 范围。before/after/diff 单字段 16KB 截断沿用 store 现有 sanitize。

### 3.4 AI 交互类

| 类型 | 语义 | 关键字段 |
| --- | --- | --- |
| `hint_requested` | 用户发起一次 AI 求助 | `intent: MessageIntent`、`userPrompt`、`selection?`、`relatedCompileEventId?`(v2 泛化 `relatedEventIds?`) |
| `ai_answer_outcome` | (v2 新增,**待定**)一次回答的结果侧记录 | `intent`、`outcome: 'delivered' \| 'fallback' \| 'corrected'`、`relatedHintEventId`、`referenceCount?` |

- `hint_requested` 的 `intent` 复用 `src/chat/types.ts` 的 `MessageIntent`
  (chat/hint/code_explanation/concept_explanation/error_explanation/
  debug_suggestion/summary/code_edit);现有生产者只覆盖
  `HINT_INTENTS`(ChatSession.ts:42-49)。
- `ai_answer_outcome` 的动机是 #13:Agent 复盘「这次求助有没有解决问题」需要
  回答侧信号(#27 已有兜底/教学更正事实,可确定性供给)。是否进 v2 见开放
  问题 Q5。

### 3.5 调试会话类(一次排错的起止)

两种形态:

- **A(推荐):派生不落盘。** 「一个错误 episode」由 `errorLifecycle` 现有逻辑
  从事件流确定性派生(出现→修复编辑→消失/编译成功),#12 视图与 #13 上下文
  都直接消费派生结果。schema 只需保证派生可行:事件 id 稳定、时间戳单调、
  关联字段齐全——v2 信封已满足。
- **B:显式落盘 `episode_opened` / `episode_resolved`。** 读者免重算,但引入
  「写时判定 vs 读时判定」双口径风险,且裁尾后上下文缺失会留下悬空 episode。

取舍见开放问题 Q1。

## 4. errorFingerprint 复用

`ErrorSignature { normalizedMessage, code?, knowledgeTags[], file? }` 是全链路
唯一的错误身份原语,v2 在三处复用:

1. **写入侧(建议新增)**:`compile_error` 事件带 `fingerprints?: ErrorSignature[]`,
   与 `parsedErrors` 中 error/warning 级诊断一一对应。动机:归一化规则
   (`normalizeErrorMessage`)未来若调整,历史事件读时现算会得到不同指纹,
   跨版本不可比;写时固化让旧事件身份稳定。
2. **去重键**:`signatureKey(signature, { mode: 'fuzzy' })` 作「同一个错」的
   判等键(归一化后同 message 即同错,与行号/标识符无关);`knowledge` 模式
   用于跨错误归并到同一知识卡片(现有 `knowledgeCard.ts` 逻辑)。
3. **生命周期匹配**:`errorLifecycle` 已用 fuzzy 匹配判定「该错在后续编译中
   是否消失」,v2 不变。

兼容:v1 事件无 `fingerprints` 字段,读取侧 fallback 为「读时用当前规则现算」
(即 v1 行为)。是否接受写时固化见开放问题 Q2。

## 5. Schema 版本化与向后兼容

1. **逐条版本号**:v2 起信封加 `schemaVersion: number`;**缺省视为 1**
   (v1 事件全部无此字段,天然成立)。
2. **只增不改**:新版本只允许新增可选字段、新增事件类型;不改名、不改语义、
   不删字段。需要破坏性变更时开 `schemaVersion: 3` 并走迁移(见 4)。
3. **混合流读取**:同一 `events.jsonl` 允许 v1/v2 记录共存;读取侧逐行
   `JSON.parse` + 容错(现有 `parseEvents` 已忽略坏行),缺字段补默认值,
   未知类型**跳过但计入统计**(索引 counts 按 type 字符串键控,天然容纳新
   类型)。
4. **不做急切迁移**:不重写历史文件。若未来确需破坏性变更,开新文件
   (如 `events.v3.jsonl`)+ 一次性导入,旧文件只读保留至自然裁尾。
5. **索引自带版本**:`index.json` 加 `version` 字段;重建索引(裁尾时已在
   重建)按读取规则兼容混合流。
6. globalState 热缓存/索引副本键名已带 `.v1` 后缀,升级时直接换新键,旧键
   弃置不迁移(缓存可再生,无迁移价值)。

## 6. 存储格式:与 ADD3 / #11 对齐(同基座,不同流)

**共同基座**(ADD3 已拍板,grill Q3 随 #11 落地):`StorageUri` 根 + 逐工作区
目录 + JSONL 追加写 + 目录名 = `sha256(工作区 Uri)` 短哈希。事件流现状已符合
该形态(`globalStorageUri/debug-journey/<wsId>/events.jsonl`),唯一差距是
append 为整体重写(实现债,见 §2)。

**两条流,职责分开**:

| | 事件流(本 schema) | 运行历史(#11,grill R2-Q2 已定) |
| --- | --- | --- |
| 内容 | 编译/运行/编辑/AI 交互的**跨链路时间线** | 单 exe 逐次运行的**全量输入输出** |
| 粒度 | 每工作区一条 `events.jsonl` | 每 exe 一条 JSONL,键 = workspaceUri + exe 绝对路径 |
| 保留 | 2000 条环形,超限裁 10% | 每 exe 最近 20 次环形 |
| 字段截断 | 单字段 16KB | stdout/stderr 64KB 头尾截断(中间插「…N bytes 省略…」) |
| 读者 | #12 视图、#13 Agent、#14 聚合、//show-log | 运行面板历史回显;事件经 `runRecordRef` 引用 |

要点:**事件流不复制运行全文**。`run_completed` / `run_error` 只存摘要(字节
数 + 短预览 + 截断标记)+ `runRecordRef` 指向运行历史记录;需要全文时(如
#13 给 Agent 看某次运行输出)按引用去运行历史流读。运行历史记录的内部格式
由 #11 落地定义,本 schema 只约定引用字段名。

建议目录形态(与 #11 落地实现对齐,最终以 ADD3 存储原语代码为准):

```
<globalStorageUri>/debug-journey/<wsId>/events.jsonl     ← 事件流(现状沿用)
<globalStorageUri>/debug-journey/<wsId>/index.json       ← 事件流索引
<globalStorageUri>/run-history/<wsId>/<exeKey>.jsonl     ← 运行历史流(#11 定)
```

## 7. 生产者 / 消费者矩阵

| 事件类型 | 生产者(现状 → v2) | 消费者 |
| --- | --- | --- |
| `compile_error` / `compile_success` | extension.ts 编译链路(compileHandlerAsync / runCodeHandlerAsync,现状)→ #8 make 链路补 `buildTool` | #12 视图、#13 上下文、#14 聚合、//show-log、debugJourneySummary |
| `run_completed` / `run_error` | **#11 Run 面板(v2 新增生产者)**;v1 无生产者 | 同上;运行面板自身主要读运行历史流 |
| `code_modified` | extension.ts 编译前快照比对(现仅 `pre_compile`) | #12 视图、#14 修复链、errorLifecycle |
| `hint_requested` | ChatSession._recordHintRequested(HINT_INTENTS)、extension.ts explain 处理器(现状) | #12 视图、#13(求助→解决判定)、#14 求助比例统计 |
| `ai_answer_outcome`(待定) | ChatSession 回答完成/兜底/更正通路(#27 已有事实来源) | #13 复盘、#12 视图 |
| 调试会话 episode | 派生(errorLifecycle,推荐)或显式落盘(待定) | #12 视图分集、#13 「最近一次排错」上下文 |

消费者侧统一只经 `DebugJourneyStore` 的读接口,不直接碰文件(见 §8)。

## 8. #14 错题本在 schema 上的落点(只读读接口)

按 grill R2-Q2,#14 导出**仅留只读读接口,格式等 #14 立项**。schema 需要
保证的是「聚合/去重/版本链可确定性派生」,并把读面固定为稳定契约:

```ts
// 稳定读接口(实例面)
interface MistakeBookReadApi {
    getEvents(filter?: DebugEventFilter): Promise<DebugEvent[]>;
    getIndex(): Promise<DebugEventIndex>;
}
// 稳定派生层(纯函数,均已存在,签名保持)
buildErrorLifecycles(events, options): ErrorLifecycle[];       // 版本链原料
mergeAndSortKnowledgeCards(cards): KnowledgeCard[];            // 归卡+排序
buildJourneySummary(store, options): JourneySummary;           // 指标汇总
buildNotebookInput(store, options): DebugNotebookInput;        // 导出输入
```

三个聚合概念的 schema 落点:

1. **题目级聚合**:v2 信封新增 `problemKey?: string`。一次排错属于哪道题,
   事件写入时打上该键;缺省时聚合退化为按工作区(现状)。`problemKey` 的
   判定规则(是否复用 architecture-v5 的题目根目录识别)见开放问题 Q4——
   **schema 只留字段,不定规则**。
2. **去重**:同一错误判等用 `signatureKey(fuzzy)`(§4);修复样例去重沿用
   `makeFixDedupKey`(归一化 before/after)。两层去重都是纯函数,不依赖存储
   格式。
3. **版本链**:「同一道题的同一个错,第 N 次犯」= 同一
   `(problemKey ?? workspaceId, signatureKey)` 下的 `ErrorLifecycle` 序列,按
   `firstSeenAt` 排序;链节之间由 `resolvingEditId` → `code_modified` 事件串起
   修复动作。schema 的保证是:`id` 稳定唯一、`relatedEventIds` 关联齐全、
   裁尾以整条流尾部批量裁(不抽中间),链在 2000 条窗口内可完整还原。

## 9. Schema 草案(TypeScript interface)

```ts
// ===== 信封 =====
export const EVENT_SCHEMA_VERSION = 2;

export interface EventEnvelope {
    /** 缺省(无此字段)按 1 处理 */
    schemaVersion?: number;
    id: string;
    type: DebugEventType;
    timestamp: number;
    sessionId: string;
    workspaceId: string;
    fileUri?: string;
    /** v2:#14 题目级聚合键;判定规则 #14 立项定,缺省 = 按工作区聚合 */
    problemKey?: string;
    /** v2:泛化关联(编译错误↔求助↔修复编辑);v1 的 relatedCompileEventId /
        relatedEventId 读取侧归并进来,写入侧逐步切到本字段 */
    relatedEventIds?: string[];
}

// ===== 类型枚举(v2) =====
export type DebugEventType =
    | 'compile_error' | 'compile_success'      // 编译(v1)
    | 'run_completed' | 'run_error'            // 运行(run_completed 为 v2 新增)
    | 'code_modified'                          // 代码编辑(v1)
    | 'hint_requested'                         // AI 交互(v1)
    | 'ai_answer_outcome';                     // AI 交互(v2,待定 Q5)

// ===== 编译 =====
export interface CompileErrorEvent extends EventEnvelope {
    type: 'compile_error';
    stderr: string;
    parsedErrors: ParsedError[];
    /** v2:与 parsedErrors 中 error/warning 级一一对应;缺省读时现算 */
    fingerprints?: ErrorSignature[];
    exitCode: number | null;
    durationMs: number;
    buildTool?: 'g++' | 'make';                // v2,#8 预留
    command?: string;                          // v2
}

export interface CompileSuccessEvent extends EventEnvelope {
    type: 'compile_success';
    exitCode: number | null;
    durationMs: number;
    buildTool?: 'g++' | 'make';                // v2
    outputPath?: string;                       // v2
}

// ===== 运行(#11 落地后才有生产者) =====
export interface RunRecordRef {
    exeKey: string;    // 运行历史流内 exe 键(workspaceUri + exe 绝对路径派生)
    recordId: string;  // 该 exe JSONL 内的记录 id
}

interface RunEventBase extends EventEnvelope {
    executablePath: string;
    exitCode: number | null;
    durationMs: number;
    stdoutBytes: number;
    stderrBytes: number;
    stdoutPreview?: string;   // ≤512 字符
    stderrPreview?: string;
    truncated: boolean;       // 预览相对完整输出是否被截
    runRecordRef?: RunRecordRef;
}

export interface RunCompletedEvent extends RunEventBase {
    type: 'run_completed';
}

export interface RunErrorEvent extends RunEventBase {
    type: 'run_error';
    reason: 'exit_nonzero' | 'killed' | 'timeout' | 'needs_input';
    // v1 兼容:旧记录可能带全文 stdout?/stderr?,读取侧继续容忍
    stdout?: string;
    stderr?: string;
}

// ===== 代码编辑(v1 不动) =====
export interface CodeModifiedEvent extends EventEnvelope {
    type: 'code_modified';
    before: string;
    after: string;
    diff: string;
    trigger: 'manual' | 'pre_compile' | 'post_compile_error';
}

// ===== AI 交互 =====
export interface HintRequestedEvent extends EventEnvelope {
    type: 'hint_requested';
    intent: MessageIntent;
    userPrompt: string;
    selection?: string;
}

export interface AiAnswerOutcomeEvent extends EventEnvelope {   // 待定 Q5
    type: 'ai_answer_outcome';
    intent: MessageIntent;
    outcome: 'delivered' | 'fallback' | 'corrected';
    relatedHintEventId: string;
    referenceCount?: number;
}
```

说明:`CompileErrorEvent.fingerprints`、`RunErrorEvent.reason` 等新字段全部可选
或带兼容注释,满足 §5「只增不改」;v1 的 `relatedCompileEventId` /
`relatedEventId` 不删,读取侧归并进 `relatedEventIds`。

## 10. 隐私与可控导出边界

1. **全部本地**:事件流与运行历史只落 `globalStorageUri` 本机目录,无遥测、
   无后台上传。
2. **内容敏感性**:事件含代码片段(before/after/diff)、stderr/stdout、用户
   prompt、绝对路径(fileUri/executablePath)。默认只进本地 UI 与本地聚合。
3. **LLM 边界**:事件数据进 LLM 只有两条显式通路——(a) 用户主动触发的错题
   本导出(debugNotebook,聚合后发送,无 key/失败退化本地模板,现状);
   (b) #13 Agent 上下文注入——必须是**摘要化 + 预算可控**的派生digest
   (如「最近 3 个未解决错误签名 + 求助次数」),不允许整卷 events.jsonl
   进提示词;接入 #13 时复用 answer 链路既有上下文预算纪律。
4. **导出边界**:导出 Markdown 走 `showSaveDialog` 用户自选位置(现状如此,
   保持);导出内容是否脱敏(绝对路径→工作区相对路径)见开放问题 Q7。
5. **用户可控清除**:`DebugJourneyStore.clear()` 已存在;#12 视图应暴露
   「清除本工作区调试记录」入口(视图需求,非 schema 变更)。字段级 16KB
   截断、2000 条环形天然限制单机留存总量。

## 11. 开放问题(需用户拍板)

| # | 问题 | 候选 | 推荐 |
| --- | --- | --- | --- |
| Q1 | 调试会话(episode)显式落盘还是派生? | A 派生(errorLifecycle 现算)/ B 落 `episode_opened`/`episode_resolved` | **A**:免双口径;裁尾不产悬空 episode |
| Q2 | `compile_error` 写时固化 `fingerprints` 还是读时现算? | A 写时固化+读时 fallback / B 维持读时现算 | **A**:normalizer 演进后旧事件身份仍稳定;成本仅写时一次现算 |
| Q3 | run 事件与 #11 运行历史的引用粒度? | A 事件存摘要+`runRecordRef` 引用(本文方案)/ B 事件自足复制 64KB 截断全文 | **A**:避免双写膨胀;两流保留策略不同(2000 条 vs 20 次),自足复制会错位 |
| Q4 | `problemKey` 判定规则何时定? | A schema 只留字段,规则 #14 立项定 / B 现在复用 architecture-v5 题目根目录识别写死 | **A**:写入侧先缺省,聚合退化按工作区,不阻塞 #12/#13 |
| Q5 | `ai_answer_outcome` 是否进 v2? | A 进(为 #13 复盘备料)/ B 暂缓,#13 立项再定 | 倾向 **A**(字段小、生产者现成),但若用户认为 #13 形态未明,可 B |
| Q6 | workspaceId hash 输入现状只取 `workspaceFolders[0].uri`,多目录工作区是否对齐 ADD3「hash=工作区 Uri」改为拼接全部 folder? | A 维持单 folder / B 拼接全部 | 倾向 **B**,但注意会改变既有工作区的目录名(旧数据成孤儿,需一次性迁移或接受重新开始) |
| Q7 | 导出/分享时绝对路径是否相对化? | A 导出时转工作区相对路径 / B 原样 | 倾向 **A**(错题本可能被分享给同学/助教) |
