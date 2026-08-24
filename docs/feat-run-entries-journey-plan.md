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
  - `JourneyEntryVM.kind` 增加 `'run_success'`;新增可选 `runErrorKind?: RunErrorKind`(条目级分类过滤用)。
  - `JourneyEpisodeVM`:
    - `severity` 扩展为 `'error' | 'warning' | 'info'`(run_success 独立卡用 info)。
    - 新增 `runErrorKind?: RunErrorKind`(独立 run_error 卡)与 `problemKey?: string`。
  - `MistakeCardVM` 增加 `problemKey?: string`。
  - 学生化文案:`RUN_ERROR_KIND_LABELS`(src/run/runErrorKind.ts)统一维护,
    viewModel 与 filters 共用,如「运行出错：数组越界(退出码 139)」/「运行成功 ✓」。
  - 构建逻辑(实现较原计划有一处增强):
    - 每个 `run_error` / `run_success` 事件各自生成一个**独立 episode**
      (run 的 fileUri 是 exe 路径,进不了 compile_error 生命周期);
      run_error 未解决置顶,run_success 按 info 进已解决日折叠区。
    - **增强**:编译 episode 的条目流按 `problemKey`(文件名去扩展名,
      main.cpp ↔ main.exe 归并为同题)归并运行条目——原计划只做独立卡,
      实现时发现精确 fileUri 匹配会让运行记录永远进不了编译 episode
      条目流,改按题目键比较。
  - `deriveProblemKey(fileUri)`:文件名去扩展名;后续可升级为读取
    `question.md` 或 PDF 标题。

### 5. 过滤与错题本分组
- **`src/journey/journeyFilters.ts`**
  - `ENTRY_TYPE_LABELS`:run_error 文案改为「运行出错」,新增 `run_success: '运行成功'`。
  - `SEVERITY_LEVEL_LABELS` 新增 `info: '信息'`(EMPTY_FILTER 同步全选)。
  - `JourneyFilterState` 新增 `runErrorKinds: RunErrorKind[]`(默认全选):
    - episode 级:`run_error` 独立卡按 kind 隐藏;
    - 条目级:编译 episode 内嵌 run_error 条目按 kind 隐藏。
  - 新增 `MistakeGroupMode = 'tag' | 'problemKey'` 与
    `groupMistakeCards(cards, mode)` 纯函数(按题目分组时无 problemKey
    归「未关联题目」置底)。

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
