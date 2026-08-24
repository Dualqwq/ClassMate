# feat/run-entries-journey 设计笔记

> 目标：把 Run 面板的运行结果接入 Debug Journey，实现 `run_success` / `run_error` 事件写入与 `run_error` 分类，并在 Journey 时间线与错题本中呈现。

## 改动文件与关键接口

### 1. 事件类型扩展
- **`src/debug/types.ts`**
  - `DebugEventType` 增加 `'run_success'`。
  - 新增 `RunSuccessEvent` 接口（与 `CompileSuccessEvent` 对称）。
  - `RunErrorEvent` 增加 `kind: RunErrorKind`。
  - `DebugEvent` union 加入 `RunSuccessEvent`；补齐 `isRunSuccess` guard。

- **`src/debug/eventEnvelope.ts`**
  - `semanticPayload` 增加 `run_success` 分支；`run_error` 分支加入 `kind`。

### 2. 运行错误分类
- **`src/run/runErrorKind.ts`**（新建）
  - 导出枚举 `RunErrorKind`：
    - `runtime_unknown`
    - `runtime_array_out_of_bounds`
    - `runtime_stack_overflow`
    - `runtime_segmentation_fault`
    - `runtime_time_limit_exceeded`
    - `runtime_interactive_input_needed`

- **`src/run/runErrorClassifier.ts`**（新建）
  - 纯函数 `classifyRunError(input)`：
    - 输入：`{ exitCode, stdout, stderr, timedOut, needsInteractiveInput }`
    - 输出：`{ kind: RunErrorKind; confidence: 'high' | 'medium' | 'low' }`
  - 规则优先级：
    1. `needsInteractiveInput` → `runtime_interactive_input_needed`（high）
    2. `timedOut` → `runtime_time_limit_exceeded`（high）
    3. stderr 显式数组越界模式（`out_of_range`、`_M_range_check`、`vector subscript`、`Index was outside`、`heap-buffer-overflow` 等）→ `runtime_array_out_of_bounds`（high）
    4. stderr 显式栈溢出模式（`stack overflow`、`StackOverflow`）→ `runtime_stack_overflow`（high）
    5. stderr SIGSEGV / Segmentation fault / Access violation → `runtime_segmentation_fault`（medium）
    6. `exitCode !== 0` 但无明确模式 → `runtime_unknown`（low）
    7. 其余（理论上不会被调用）→ `runtime_unknown`（low）
  - 同时覆盖 Windows MinGW 与 Linux/macOS 常见 stderr 文本。

### 3. RunService 接入 DebugJourneyStore
- **`src/run/runService.ts`**
  - 构造函数增加可选注入：
    ```ts
    constructor(
      context: vscode.ExtensionContext,
      options?: { debugStore?: DebugJourneyStore; sessionId?: string }
    )
    ```
  - 运行结束后，在把记录落盘 `RunHistoryStore` 的同时：
    - `exitCode === 0 && !timedOut && !needsInteractiveInput` → 写入 `run_success` 事件。
    - 否则 → 写入 `run_error` 事件（带 `kind`）。
  - 事件字段：
    - `id`、`timestamp`、`sessionId`、`workspaceId`（从 `debugStore.workspaceId` 取）、`fileUri`（exe 路径转 `file://`）。
    - `run_success`：`exitCode`、`durationMs`。
    - `run_error`：`executablePath`、`stdout`、`stderr`、`exitCode`、`durationMs`、`kind`。
  - 未注入 `debugStore` 时行为不变，保持单测可测性。

- **`src/extension.ts`**
  - 实例化 `RunService` 时注入 `{ debugStore, sessionId }`。

### 4. Journey 视图模型支持 run 条目
- **`src/journey/journeyViewModel.ts`**
  - `JourneyEntryVM.kind` 增加 `'run_success'`。
  - `JourneyEpisodeVM` 增加可选字段：
    - `problemKey?: string`
    - `runErrorKind?: RunErrorKind`（run_error episode 专用）
  - `MistakeCardVM` 增加 `problemKey?: string`。
  - 新增 run 事件学生化文案映射：
    - `run_success` → "运行成功 ✓"
    - `run_error` 各 kind → "运行出错：数组越界" 等
  - 构建逻辑：
    - 在 `buildErrorLifecycles` 派生后，为每个 `run_error` 事件单独生成一个 episode（独立 episode，不依附于 compile_error）。
    - 为每个 `run_success` 事件生成一个独立 episode（resolved = true）。
    - `run_success` 也可作为同文件最近 compile episode 的条目出现（保留现有生命周期条目逻辑），但独立 episode 保证无 compile 历史时也能看到运行记录。
  - `problemKey` 派生：优先取 `fileUri` 的文件名去扩展名；无 fileUri 时为空。后续可扩展为读取 `question.md` / PDF 标题。

### 5. 过滤与错题本分组
- **`src/journey/journeyFilters.ts`**
  - `ENTRY_TYPE_LABELS` 增加 `run_success: '运行成功'`（`run_error` 已有 '运行'）。
  - 新增 `RUN_ERROR_KIND_LABELS: Record<RunErrorKind, string>`。
  - `JourneyFilterState` 增加 `runErrorKinds?: RunErrorKind[]`（仅当 run_error 类型被选中时生效，未实现代价可控）。
  - 过滤函数 `episodeMatchesFilter` 与 `filterEntries` 增加 run_error kind 筛选：
    - episode 为 run_error 且其 kind 不在选中集合中时不显示。
  - 新增错题本分组相关：
    - `MistakeGroupMode = 'tag' | 'problemKey'`
    - `groupMistakeCards(cards, mode)` 纯函数，按 tag 或 problemKey 聚合。

- **`webview/src/journey/JourneyFilterBar.tsx`**
  - 类型多选区自动拿到 `run_success`（来自 `ENTRY_TYPE_LABELS`）。
  - 当 `run_error` 被选中时，额外展示 run error kind 多选 chips（使用 `RUN_ERROR_KIND_LABELS`）。

- **`webview/src/journey/MistakeBookTab.tsx`**
  - 增加分组选择器（按知识标签 / 按题目）。
  - 按题目分组时，同一 `problemKey` 的卡片折叠成一组，组头显示 problemKey。

### 6. 测试
- **`src/test/runErrorClassifier.test.ts`**（新建）
  - 覆盖 Windows MinGW / Linux / macOS 样本：数组越界、栈溢出、段错误、TLE、交互输入、未知。

- **`src/test/journeyService.test.ts`**
  - 补充：运行后通过 `JourneyService.buildView` 可见 `run_success` / `run_error` episode。

- **`src/test/journeyViewModel.test.ts`**
  - 补充：
    - `run_success` 生成独立 episode 且 resolved。
    - `run_error` 生成独立 episode 且 unresolved，label 含学生化 kind 文案。
    - `problemKey` 从 fileUri 正确派生。

- **`src/test/journeyFilters.test.ts`**
  - 补充 run 类型过滤、run error kind 过滤、按 problemKey 分组。

## 遗留问题
- `run_success` / `run_error` 的 `fileUri` 目前使用 exe 路径，尚未映射回源文件；后续可从 RunService 的 exe 发现链路带回源文件 URI。
- `problemKey` 目前仅从 fileUri 文件名派生，尚未读取 `question.md` 或 PDF 标题。
- run_error 的"解决"状态目前固定 unresolved；后续可检测后续 run_success 是否来自同一 exe 来标记解决。
