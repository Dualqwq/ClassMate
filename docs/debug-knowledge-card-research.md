# Debug Journey / Knowledge Card 匹配机制研究与覆盖补强方案

> 研究分支：`research/knowledge-card-coverage`  
> 基线：`after-0803` (HEAD = `4359041`)  
> 范围：只读功能代码，不修改实现；仅提交本文档。

## 1. 问题定义

本研究回答三个问题：

1. **为什么“单个编译错误未加入错题本”？**  
   一个编译错误从发生到出现在错题本，需要经过 `parse → match → generate → merge → sort → render` 六道关卡。任何一关失配都会导致卡片丢失。
2. **知识卡片匹配的完备性如何？**  
   当前 `errorKnowledgeMap.ts` 只有 14 个概念标签，面对真实 GCC/G++/Clang/MSVC 输出时大量常见错误无法归一化。
3. **运行错误（run_error）如何接入错题本？**  
   `run_error` 事件类型已经存在，但实际只被 `RunHistoryStore` 记录，未被写入 Debug Journey store，导致 Journey / 错题本看不到运行期错误。

## 2. 当前代码路径与关键函数

### 2.1 写入侧：编译事件如何落盘

- `src/extension.ts:391-429`：`recordCompileOutcome`
  - 失败时调用 `parseCompilerStderrWithIncludes(result.stderr)` 得到 `ParsedError[]`。
  - 构造 `CompileErrorEvent`，写入 `DebugJourneyStore.append`。
- `src/extension.ts:640-714`：`compileHandlerAsync`
  - 同样构造 `CompileErrorEvent` 并 `debugStore.append(event)`。

### 2.2 解析侧：stderr → ParsedError

- `src/error/errorParser.ts:104-212`：`extractErrorLocation`
  - 支持 GCC/Clang `:line:col: severity:`、MSVC `(line,col): severity:`、vi `+line:col:` 格式。
  - 提取 `file / line / column / severity / message / code / range`。
- `src/error/errorParser.ts:295-348`：`parseCompilerStderrWithIncludes`
  - 把头文件 include 栈附加到 `ParsedError.viaIncludes`。
  - 诊断的归属 `file` 始终是真正报错的头文件/源文件，不是 include 它的主单元。

### 2.3 匹配侧：message → knowledge tag

- `src/error/errorKnowledgeMap.ts:370-381`：`matchErrorToKnowledge`
  - 只认 `message.toLowerCase()`，按 `ERROR_PATTERNS` 顺序匹配，返回所有命中的 tag。
  - `ERROR_PATTERNS` 当前 14 条（`src/error/errorKnowledgeMap.ts:280-365`）。
- `src/error/errorKnowledgeMap.ts:386-388`：`getKnowledgeConcept`
  - 根据 tag 取完整概念元数据（标题、成因、修复建议、正反面示例）。

### 2.4 卡片生成侧：CompileErrorEvent → KnowledgeCard

- `src/debug/knowledgeCard.ts:113-175`：`generateKnowledgeCard`
  - 遍历 `errorEvent.parsedErrors`。
  - 过滤 `severity !== 'error' && severity !== 'warning'` 的直接跳过。
  - 调用 `matchErrorToKnowledge(parsed.message)`；**如果没有任何 tag 命中，`continue`，这就是“单个错误未加入错题本”的直接原因**（`knowledgeCard.ts:136-138`）。
  - 只取第一个“有 concept”的匹配作为 `bestMatch`。
  - 从 `errorLifecycle` 取解决状态、尝试次数；从 `code_modified` 取 concrete fix。
- `src/debug/knowledgeCard.ts:181-250`：`mergeKnowledgeCards`
  - 按 tag 聚合，合并 frequency / resolvedCount / unresolvedCount / concrete fixes。
- `src/debug/knowledgeCard.ts:256-269`：`sortKnowledgeCards`
  - 未解决 > 频率 > 平均尝试 > 最近。

### 2.5 生命周期侧：错误何时算“已解决”

- `src/debug/errorLifecycle.ts:47-120`：`isErrorResolved`
  - 以出错事件为起点，向后看最多 5 次同文件编译（`DEFAULT_LOOK_AHEAD_COMPILES = 5`）。
  - 出现 `compile_success` 或同签名错误消失即视为 resolved。
  - `matchOptions` 默认 `fuzzy`（归一化 message 相同即可）。
- `src/debug/errorLifecycle.ts:125-166`：`buildErrorLifecycles`
  - 为每个 error/warning 诊断建立一条 `ErrorLifecycle`。
- `src/debug/errorFingerprint.ts:25-35`：`normalizeErrorMessage`
  - 小写化；把引号内标识符替换为 `<id>`；把数字替换为 `<num>`；折叠空白。

### 2.6 UI 侧：视图模型 → 错题本

- `src/journey/journeyViewModel.ts:291-423`：`buildJourneyViewModel`
  - 读取 store 全部事件，跑 `buildErrorLifecycles`。
  - 按事件+签名+级别折叠 episode（修复 ×8 同错复制问题）。
  - 调用 `generateKnowledgeCard` + `mergeAndSortKnowledgeCards` 生成 `MistakeCardVM`。
  - `representativePosition` 使用 `pickRepresentativeError`（`knowledgeCard.ts:278-292`），仍然回到 `matchErrorToKnowledge` 拿 representative 诊断行。

### 2.7 Run 侧：运行错误为何“缺席”

- `src/run/runService.ts:139-217`：`run`
  - 运行结束后构造 `RunRecord`，写入 `RunHistoryStore.append(record)`（`runService.ts:205`）。
  - **从未构造 `RunErrorEvent`，也从未写入 `DebugJourneyStore`**。
- `src/debug/types.ts:41-48`：`RunErrorEvent` 类型已就绪。
- `src/debug/eventEnvelope.ts:75-80`：语义指纹已支持 `run_error`。
- `src/debug/debugJourneyStore.ts:131-134`：幂等跳过已把 `run_error` 纳入。
- `src/journey/journeyViewModel.ts:212-219`：视图模型已能渲染 `run_error` 时间线条目（只要 store 里有）。
- `src/debug/debugJourneyTreeNodes.ts:162-177`：侧边栏也已能渲染 `runErrorNode`。

### 2.8 完整数据流（文字流程图）

```
学生点击 Compile / 保存触发自动编译
    │
    ▼
spawnGpp / spawnMake 产出 stderr (英文, 强制 LANG=C)
    │
    ▼
parseCompilerStderrWithIncludes(stderr)
    ├─ 提取 ParsedError[]（含 file/line/message/viaIncludes）
    └─ include 栈归因：头文件错误保留引入链路
    │
    ▼
extension.ts 构造 CompileErrorEvent
    └─ DebugJourneyStore.append(event)
         ├─ eventEnvelope.computeEventFingerprint → v2 schema
         └─ 5s 窗口内同指纹幂等跳过
    │
    ▼
JourneyService / DebugJourneyTreeProvider 读取 store
    │
    ▼
buildJourneyViewModel(events)
    ├─ buildErrorLifecycles → ErrorLifecycle[]（向后 5 次编译判定解决）
    ├─ foldByFingerprint → 去重同一窗口内的重复事件
    ├─ generateKnowledgeCard(event, events, lifecycles)
    │      └─ matchErrorToKnowledge(parsed.message)
    │             ├─ HIT → 取 bestMatch + concept → KnowledgeCard
    │             └─ MISS → continue（错误在这里丢失）
    ├─ mergeAndSortKnowledgeCards → 按 tag 聚合
    └─ 映射为 MistakeCardVM → webview 渲染错题本
```

## 3. “单个编译错误未加入错题本”的根因

### 3.1 根因结论

**唯一关卡： `generateKnowledgeCard` 中 `matchErrorToKnowledge(parsed.message)` 返回空数组。**

代码位置：

```ts
// src/debug/knowledgeCard.ts:134-138
const matches = matchErrorToKnowledge(parsed.message);
const bestMatch = matches.find((m) => getKnowledgeConcept(m.tag) !== undefined);
if (!bestMatch) {
    continue;
}
```

只要诊断消息不在 `ERROR_PATTERNS` 的 14 条正则里，这条诊断就会被 `continue` 掉，无法形成 KnowledgeCard，后续 merge/sort/render 都看不到它。

### 3.2 验证方法

使用临时脚本调用 `matchErrorToKnowledge`（未提交），结果如下：

| # | 真实/典型错误消息 | 命中 tag | 是否丢失 |
|---|------------------|---------|---------|
| 1 | `expected ';' before 'return'` | `missing_semicolon`, `syntax_punctuation` | 否 |
| 2 | `'x' was not declared in this scope` | `undeclared_identifier` | 否 |
| 3 | `invalid operands of types 'int' and 'const char [2]' to binary 'operator<<'` | — | **是** |
| 4 | `lvalue required as left operand of assignment` | — | **是** |
| 5 | `array subscript out of bounds` | — | **是** |
| 6 | `request for member 'x' in 'y', which is of non-class type 'int'` | — | **是** |
| 7 | `reference to 'count' is ambiguous` | — | **是** |
| 8 | `candidate expects 2 arguments, 1 provided` | — | **是** |
| 9 | `narrowing conversion of 'x' from 'int' to 'char'` | — | **是** |
| 10 | `non-aggregate type 'vector<int>' cannot be initialized with an initializer list` | — | **是** |
| 11 | `field 'x' has incomplete type 'S'` | — | **是** |
| 12 | `base operand of '->' has non-pointer type` | — | **是** |
| 13 | `cannot bind non-const lvalue reference of type 'int&' to an rvalue of type 'int'` | — | **是** |
| 14 | `control reaches end of non-void function` | — | **是** |
| 15 | `Microsoft C++ exception: std::out_of_range at memory location` | — | **是** |

### 3.3 会“丢失”的典型模式分类

| 类别 | 典型消息片段 | 当前缺失 |
|------|-------------|---------|
| 运算符/操作数错误 | `invalid operands`, `no match for operator`, `base operand of '->'` | 无 |
| 左值/引用绑定 | `lvalue required`, `cannot bind ... reference`, `discards qualifiers` | 无 |
| 数组越界 | `array subscript out of bounds`, `subscript out of range` | 无 |
| 重载/歧义 | `ambiguous`, `candidate expects`, `no match for call` 变体 | 仅覆盖 `no matching function for call to` |
| 类型窄化 | `narrowing conversion`, `invalid conversion` | 仅覆盖 `cannot convert` |
| 类型不完整 | `incomplete type`, `forward declaration` | 无 |
| 控制流 | `control reaches end of non-void function` | 无 |
| 宏/预处理 | `expected identifier`, `#error` | 部分归入 `syntax_punctuation` |
| MSVC 运行期 | `C++ exception`, `Assertion failed` | 无（运行期也暂无） |

## 4. 知识卡片匹配完备性评估

### 4.1 当前覆盖

`errorKnowledgeMap.ts` 现有 14 个 concept：

- C/C++ 编译/链接：12 个
  - `missing_semicolon`, `undeclared_identifier`, `function_call_mismatch`, `type_conversion`, `undefined_reference`, `multiple_definition`, `non_static_member`, `private_access`, `segmentation_fault`, `syntax_punctuation`, `missing_library`, `missing_header`
- Make 构建：2 个
  - `make_no_rule`, `make_missing_separator`

### 4.2 覆盖缺口

按错误类别估算缺口：

| 来源 | 已覆盖常见错误 | 明显未覆盖 |
|------|---------------|-----------|
| GCC/G++ | 分号、未声明、函数调用、类型转换、链接、重复定义、static/private、segfault、头文件、库 | 运算符操作数、左值、数组越界、重载歧义、窄化、不完整类型、控制流 |
| Clang | 同上（消息文本略有差异） | `use of undeclared identifier` 已覆盖；但 `invalid operands to binary expression` 未覆盖 |
| MSVC | `error C...` 格式可被 parser 识别，但知识标签几乎未针对 MSVC 文案定制 | `C++ exception`, `Assertion failed`, `unresolved external symbol` 等 |
| STL/模板 | 无专门标签 | `no matching function` 能覆盖部分；模板实例化 note 完全不覆盖 |

### 4.3 同一错误的多消息变体

当前部分标签只覆盖了一种表述，容易漏掉变体：

| tag | 当前 pattern | 未覆盖变体 |
|-----|-------------|-----------|
| `undeclared_identifier` | `was not declared in this scope` | Clang `use of undeclared identifier`（实际已命中，因为包含 `identifier` 不，等等，当前 pattern 是 `was not declared in this scope`，Clang 消息是 `use of undeclared identifier 'x'`，**当前不会命中**） |
| `function_call_mismatch` | `no matching function for call to` | `candidate expects N arguments, M provided`；`too many arguments to function`；`too few arguments to function` |
| `type_conversion` | `cannot convert` | `invalid conversion`；`narrowing conversion`；`cannot bind ... reference` |
| `missing_header` | `no such file or directory` | Clang fatal error `'xxx' file not found`（parser 已忽略 fatal error 行，连 ParsedError 都不会产生） |
| `undefined_reference` | `undefined reference to` | MSVC `unresolved external symbol`；`ld: symbol(s) not found` |
| `multiple_definition` | `multiple definition of` | `redefinition of`（同一翻译单元内） |

### 4.4 include 栈归因对匹配的影响

- `matchErrorToKnowledge` 只看 `parsed.message`，不看 `viaIncludes`。
- 因此头文件错误只要消息文本被覆盖，就能正常生成知识卡片；include 链路仅用于 UI 展示和跳转。
- **风险**：头文件中的 `no such file or directory` 实际消息仍然是 `fatal error: 'xxx' file not found`，这类 fatal error 当前 `extractErrorLocation` 不解析（`errorParser.test.ts:147-157` 明确返回 `undefined`），所以头文件缺失场景下连 `ParsedError` 都没有，自然无法入卡。

## 5. 推荐补齐的 `errorKnowledgeMap` 条目列表

按“高价值 + 高频率”原则，建议新增/补强以下条目。新增 tag 不会破坏现有卡片聚合（merge 按 tag），但需要在 `knowledgeCards.test.ts:79` 的 `concepts.length` 断言同步更新。

### 5.1 新增概念（建议）

| tag | title | 触发消息（正则） | 教学价值 |
|-----|-------|-----------------|---------|
| `operator_operand_mismatch` | 运算符操作数不匹配 | `invalid operands`, `no match for operator`, `invalid operands to binary expression` | 高，新手常把 `<<` 当字符串拼接 |
| `lvalue_required` | 赋值左值错误 | `lvalue required` | 高，常见于 `a + b = c` |
| `array_out_of_bounds` | 数组越界 | `array subscript out of bounds`, `subscript out of range` | 高，运行期 segfault 的前奏 |
| `overload_ambiguous` | 重载调用歧义 | `ambiguous`, `candidate expects .* arguments .* provided`, `too many arguments`, `too few arguments` | 高，函数/构造重载是难点 |
| `narrowing_conversion` | 窄化转换 | `narrowing conversion`, `invalid conversion` | 中， brace-init 常见 |
| `incomplete_type` | 不完整类型 | `incomplete type`, `forward declaration` | 中，struct 前置声明误用 |
| `pointer_dereference_mismatch` | 指针/解引用不匹配 | `base operand of '->'`, `request for member .* in .* which is of non-class type`, `invalid types .* for array subscript` | 高，`.` 与 `->` 混淆 |
| `const_qualifier_mismatch` | const/引用绑定错误 | `cannot bind .* reference`, `discards qualifiers` | 中，面向对象入门 |
| `control_flow_return` | 控制流返回错误 | `control reaches end of non-void function`, `not all control paths return a value` | 高，函数遗漏 return |
| `redefinition` | 符号重定义 | `redeclaration of`, `redefinition of` | 中，区分 `multiple_definition`（链接期） |
| `missing_header_clang` | 头文件未找到（Clang） | `'.*' file not found` | 高，需要 parser 也解析 fatal error 行 |

### 5.2 现有 pattern 补强建议

| tag | 建议补充 pattern |
|-----|-----------------|
| `undeclared_identifier` | `use of undeclared identifier` |
| `function_call_mismatch` | `candidate expects`, `too many arguments to function`, `too few arguments to function` |
| `type_conversion` | `invalid conversion`, `narrowing conversion` |
| `undefined_reference` | `unresolved external symbol`, `symbol(s) not found for architecture` |
| `missing_header` | `'.*' file not found`（需 parser 配合） |
| `multiple_definition` | `redefinition of` |

### 5.3 对 `missing_header_clang` 的特别说明

当前 `extractErrorLocation` 不解析 `fatal error: 'xxx' file not found`（无 file:line:severity 前缀）。若想让 Clang 头文件缺失入卡，需要：

1. 在 `errorParser.ts` 增加对 `fatal error: ... file not found` 的特判，或放宽 `severityMarkerPattern` 允许无 location 的 fatal error。
2. 新增 `missing_header_clang` tag（或合并进 `missing_header`）。

这与“只改知识标签、不动 parser”的范围冲突，建议作为独立修复项。

## 6. `run_error` 接入错题本的设计草案

### 6.1 当前状态

- `RunErrorEvent` 类型、`eventEnvelope` 指纹、`debugJourneyStore` 幂等跳过、`journeyViewModel` 渲染、`debugJourneyTreeNodes` 节点全部就绪。
- 唯一缺失：**`RunService` 没有把运行结果写入 `DebugJourneyStore`**。

### 6.2 写入点设计

在 `src/run/runService.ts:205` 附近，追加写入 Debug Journey store：

```ts
// 概念伪代码，不提交
const runErrorEvent: RunErrorEvent = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    type: 'run_error',
    timestamp: Date.now(),
    sessionId: currentSessionId,
    workspaceId: currentWorkspaceId,
    fileUri: activeSourceUri, // 运行时的 active 源文件，作为关联文件
    executablePath: executable.path,
    stdout: stdout.text,
    stderr: stderr.text,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
};
if (result.exitCode !== 0 || result.timedOut || result.needsInteractiveInput) {
    await debugJourneyStore.append(runErrorEvent);
}
```

注入 `DebugJourneyStore` 到 `RunService` 构造函数（当前只注入 `vscode.ExtensionContext`）。

### 6.3 运行错误知识分类字段

建议新增 `src/run/runErrorKnowledgeMap.ts`，与 `errorKnowledgeMap.ts` 同构：

| tag | title | 触发条件（stdout/stderr/exitCode） |
|-----|-------|----------------------------------|
| `runtime_array_out_of_bounds` | 运行期数组越界 | `std::out_of_range`, `vector::_M_range_check`, `Array subscript out of range` |
| `runtime_null_pointer` | 空指针解引用 | `Segmentation fault` + 地址 0x0 附近；`EXC_BAD_ACCESS` |
| `runtime_assertion_failed` | 断言失败 | `Assertion failed`, `assertion "..." failed` |
| `runtime_uncaught_exception` | 未捕获异常 | `Microsoft C++ exception`, `terminate called after throwing`, `std::runtime_error` |
| `runtime_stack_overflow` | 栈溢出 / 递归过深 | `stack overflow`, `SIGSEGV` 且重复调用栈极深 |
| `runtime_infinite_loop` | 运行超时 / 死循环 | `timedOut === true` |
| `runtime_interactive_input` | 需要交互输入 | `needsInteractiveInput === true` |
| `runtime_exit_code_nonzero` | 程序异常退出 | `exitCode !== 0` 但 stderr 为空（兜底） |

匹配策略：

1. 先用确定性正则匹配 stderr/stdout。
2. 再用 `exitCode` 和 `timedOut` / `needsInteractiveInput` 兜底。
3. 无法识别时落入 `runtime_unknown`，避免完全丢失。

### 6.4 生命周期处理

运行错误没有“编译 → 编辑 → 编译成功”的清晰对应关系，建议：

- **不建立 `ErrorLifecycle`**（`buildErrorLifecycles` 只处理 `compile_error`）。
- **resolved 判定**：
  - 方案 A（推荐）：后续同一 `fileUri` 出现 `compile_success` + 同一 exe 的 `run_error` 不再出现，视为 resolved。
  - 方案 B：后续同一 `fileUri` 出现任意 `code_modified` 且随后同一 exe 运行成功（`exitCode === 0`），视为 resolved。
  - 方案 C（简单）：运行错误默认 unresolved，学生手动点击“已解决”或“忽略”。
- **concrete fixes**：运行错误无法像编译错误那样从 `code_modified` 提取精确 diff。可退化为展示学生在该运行错误前后 60 秒内的 code_modified 片段作为“尝试修复记录”。

### 6.5 错题本卡片形态

`MistakeCardVM` 已兼容 run_error 字段（`fileUri`/`line` 可选）。运行时卡片可显示：

- phenomenon：stderr 第一行或 `运行出错(退出码 ${exitCode})`
- commonCauses / checkMethod：来自 `runErrorKnowledgeMap`
- fixes：该错误前后最近的 code_modified 快照（最多 3 条）
- 跳转：若 stderr 含文件行号可解析（如断言失败），则定位；否则只定位到运行源文件

### 6.6 与 `RunHistoryStore` 的关系

- `RunHistoryStore` 保留“按 exe 分组的历史记录”，面向 Run 面板。
- `DebugJourneyStore` 保留“按工作区时间线的运行错误事件”，面向 Journey / 错题本。
- 两者独立写入，数据冗余可接受；或让 `RunService` 同时写两份。

## 7. LLM 辅助匹配评估

### 7.1 方案描述

对 `matchErrorToKnowledge` 返回空的诊断消息，调用 LLM 做一次“标签归一化”：输入 `message` + 可选 `code`（如 `-Wreturn-type`），输出一个已知 tag 或新 tag 建议。

### 7.2 可行性、成本、延迟、准确性

| 维度 | 评估 |
|------|------|
| 可行性 | 高。消息文本短，可直接走现有 LLM adapter（`src/chat/llm/` 或 `src/prompts/`）。 |
| 成本 | 中。每次编译失败若有多条未识别错误，会触发多次 LLM call；高频编译场景成本累积。 |
| 延迟 | 高。卡片生成在 Journey 面板刷新路径上，同步等待 LLM 会显著拖慢 UI。必须改为异步后台标记 + 下次刷新生效。 |
| 准确性 | 中。LLM 对常见错误归类准确，但可能把多个子类合并到同一标签，或产生训练数据里没有的 tag；需要严格的输出 schema 校验。 |
| 副作用 | 破坏纯函数。`generateKnowledgeCard` / `buildJourneyViewModel` 当前是纯函数、可单测；引入 LLM 后需要异步化并引入网络依赖。 |

### 7.3 结论

**推荐：只在特定兜底场景做。**

- **不推荐作为默认路径**：增加延迟、成本和不可预测性，且与当前纯函数派生架构冲突。
- **推荐作为“未知错误聚类”的离线/后台任务**：当某类未识别错误出现 3 次以上时，后台调用 LLM 建议新 tag 并写入本地候选标签缓存；运营/开发者确认后固化到 `errorKnowledgeMap.ts`。
- **不推荐用 LLM 直接生成 concept 元数据**（标题、修复建议、示例）：教学文案必须严格符合学生水平，需人工审核。

## 8. 后续实施优先级建议

### P0：补齐高频编译错误标签（1-2 天）

1. 在 `errorKnowledgeMap.ts` 新增/补强 pattern，覆盖：
   - Clang `use of undeclared identifier`
   - `invalid operands` / `no match for operator`
   - `lvalue required`
   - `array subscript out of bounds`
   - `candidate expects ... arguments` / `too many/few arguments`
   - `narrowing conversion` / `invalid conversion`
   - `control reaches end of non-void function`
   - `redefinition of`
2. 同步更新 `knowledgeCards.test.ts` 的 `concepts.length` 断言和新增样本测试。
3. 跑 `npm run test` 全绿。

### P1：把 `run_error` 写入 Debug Journey store（2-3 天）

1. 给 `RunService` 注入 `DebugJourneyStore`。
2. 运行失败/超时/交互兜底时写入 `RunErrorEvent`。
3. 新增 `src/run/runErrorKnowledgeMap.ts` 和单元测试。
4. 在 `journeyViewModel.ts` 中实现 run_error 的 resolved 判定（推荐方案 A：后续 compile_success + 无重复 run_error）。
5. 更新 `journeyViewModel.test.ts` / `runService.test.ts` 验证时间线与卡片。

### P2：解析无 location 的 fatal error（1 天）

1. 在 `errorParser.ts` 特判 `fatal error: 'xxx' file not found`。
2. 合并到 `missing_header` tag 或新增 `missing_header_clang`。
3. 补充 `errorParser.test.ts` 样本。

### P3：LLM 辅助未知错误聚类（调研/后台任务，不做默认）

1. 设计后台任务：统计未识别 message，≥3 次触发 LLM 建议标签。
2. 输出到本地候选文件或 telemetry，人工审核后固化。
3. 明确不做在线同步匹配。

### P4：MSVC 文案专项（可选）

1. 收集 MSVC 常见错误消息。
2. 为 `undefined_reference` / `missing_header` / `type_conversion` 等增加 MSVC 变体 pattern。

---

## 附录：关键文件引用速查

| 文件 | 相关行号 | 说明 |
|------|---------|------|
| `src/error/errorKnowledgeMap.ts` | 25-277 | concept 定义 |
| `src/error/errorKnowledgeMap.ts` | 280-365 | ERROR_PATTERNS |
| `src/error/errorKnowledgeMap.ts` | 370-381 | `matchErrorToKnowledge` |
| `src/debug/knowledgeCard.ts` | 113-175 | `generateKnowledgeCard` |
| `src/debug/knowledgeCard.ts` | 136-138 | 未命中则 continue（丢失根因） |
| `src/debug/errorLifecycle.ts` | 47-120 | `isErrorResolved` |
| `src/journey/journeyViewModel.ts` | 291-423 | `buildJourneyViewModel` |
| `src/run/runService.ts` | 139-217 | `run`，只写 RunHistoryStore |
| `src/run/runService.ts` | 205 | 应在此处补写 DebugJourneyStore |
| `src/debug/types.ts` | 41-48 | `RunErrorEvent` |
| `src/debug/eventEnvelope.ts` | 75-80 | `run_error` 指纹 |
