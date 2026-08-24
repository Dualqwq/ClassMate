# Run 错误分类器覆盖面设计（run-error-classifier-coverage）

> 状态：**设计文档，待拍板，未实施**。分支 `docs/run-error-classifier-coverage`，基于 `after-0803` @ `770254f`。
> 范围：纯文档。不改任何功能代码、测试、CHANGELOG。
>
> 触发背景：用户实测反例——
> ```
> terminate called after throwing an instance of 'std::bad_alloc'
>   what():  std::bad_alloc
> ```
> 这类错误实际多由数组越界引起（越界下标 / 负数循环边界 → `new[]` 申请超大内存 → 分配失败 abort），但当前分类器无法定位到「数组越界」，落入未知兜底。

---

## 1. 现状盘点

### 1.1 现有六类（`src/run/runErrorKind.ts`）

| kind | 学生化文案 |
| --- | --- |
| `runtime_unknown` | 运行出错：原因不明 |
| `runtime_array_out_of_bounds` | 运行出错：数组越界 |
| `runtime_stack_overflow` | 运行出错：栈溢出(常见于过深递归) |
| `runtime_segmentation_fault` | 运行出错：非法内存访问(段错误) |
| `runtime_time_limit_exceeded` | 运行出错：超出时限(可能是死循环) |
| `runtime_interactive_input_needed` | 运行出错：程序在等待输入 |

### 1.2 现有判定规则与优先级（`src/run/runErrorClassifier.ts:69-104`）

按顺序短路返回：

1. `needsInteractiveInput` → 等待输入（high）
2. `timedOut` → 超时（high）
3. 命中 `ARRAY_OUT_OF_BOUNDS_PATTERNS`（10 条：`std::out_of_range`、`vector::_M_range_check`、`vector subscript out of range`、`Index was outside the bounds`、`array subscript out of (bounds|range)`、`heap-buffer-overflow`、`stack-buffer-overflow`、`global-buffer-overflow`、`buffer overflow`、`index out of (bounds|range)`）→ 数组越界（high）
4. 命中 `STACK_OVERFLOW_PATTERNS`（4 条：`stack overflow`、`StackOverflow`、`exceeded maximum recursion depth`、`__stack_chk_fail`）→ 栈溢出（high）
5. 命中 `SEGMENTATION_FAULT_PATTERNS`（7 条：`segmentation fault`、`SIGSEGV`、`segfault`、`access violation`、`0xc0000005`、`invalid memory access`、**`SIGABRT`**、**`aborted…core dumped`**）→ 段错误（medium）
6. 退出码非零且无任何模式 → `runtime_unknown`（low）

匹配范围是 `stdout + stderr` 拼接文本；现有单测 12 条（`src/test/runErrorClassifier.test.ts`），覆盖 Linux libstdc++、MSVC debug、ASan、MinGW 各一两个代表样本。

### 1.3 覆盖盲区

| # | 盲区 | 后果 |
| --- | --- | --- |
| B1 | **`std::bad_alloc` / `std::bad_array_new_length` 完全不命中** | 用户反例落 `runtime_unknown`（low）。这是本次立项的直接动因。 |
| B2 | **`terminate called after throwing an instance of 'X'` 包装无解包逻辑** | 内层异常类名若不在既有模式里（如 `std::length_error`、自定义异常类），整条 stderr 不命中 → unknown。 |
| B3 | **`SIGABRT` 被归入段错误模式表**（`runErrorClassifier.ts:57-58`） | 未捕获 C++ 异常的 abort（exit code 134）只要 stderr 里出现字面 `SIGABRT` 或 `Aborted (core dumped)`，会被误标成「段错误」——语义完全错。这是现状里的一处**误分类 bug**，不只是漏分类。 |
| B4 | `std::length_error`（string/vector 长度超限）不命中 | unknown |
| B5 | SIGFPE 浮点/整数除零（Linux `Floating point exception`）不命中 | unknown |
| B6 | Windows `STATUS_STACK_OVERFLOW`（0xC00000FD，exit 3221225725）：stderr 往往只有异常码没有 "stack overflow" 字样 | 栈溢出被漏掉 → unknown |
| B7 | MSVC Debug CRT 文案未覆盖：`HEAP CORRUPTION DETECTED`、`Run-Time Check Failure #2 - Stack around the variable … was corrupted`、`abort() has been called`、`R6025 - pure virtual function call` | unknown 或误入段错误 |
| B8 | assert 失败（`Assertion failed: …, file …, line …`）走 abort 路径 | 若命中 B3 的 abort 模式会误标段错误，否则 unknown。「断言失败」是否值得单独成档见 §5 开放问题。 |

消费端影响面（新增枚举值时的改动范围，已核实）：

- `journeyFilters.ts:54` 的默认过滤集合直接展开 `RUN_ERROR_KINDS`，新档位自动进入筛选 chips；
- `journeyDigestBuilder.ts:105-106` 经 `RUN_ERROR_KIND_LABELS` 取文案，无需改；
- `debug/types.ts:56` `RunErrorEntry.kind` 引用该类型；
- webview 筛选 chips 由 filters 数据驱动，理论无需改，需人工过一眼布局。

---

## 2. 真实样本语料

格式约定：每条给出 **stderr 原文 → 应归类 → 判定正则建议**。标注来源可信度：✅ = 用户实测或现有单测已覆盖；📚 = 典型已知格式（依据 libstdc++/CRT 公开行为，未在本项目环境复现）；❓ = 存疑，标注未验证。

### 2.1 内存分配失败族

**S1** ✅ 用户实测
```
terminate called after throwing an instance of 'std::bad_alloc'
  what():  std::bad_alloc
```
→ 归类见 §3 方案讨论（推荐：`runtime_memory_alloc_failed`，medium）
→ 正则：`/std::bad_alloc/i`

**S2** 📚 无 what() 行的变体（glibc 环境下 `what()` 行可能缺失或缩进不同）
```
terminate called after throwing an instance of 'std::bad_alloc'
```
→ 同 S1
→ 正则同上（只匹配异常类名行即可覆盖两种形态）

**S3** 📚 `new[]` 尺寸非法（负数上转型为超大的 size_t，或请求超过实现上限）
```
terminate called after throwing an instance of 'std::bad_array_new_length'
  what():  bad array new length
```
→ 数组越界（证据比 bad_alloc 直接得多：`new[]` 收到了负数/超大长度参数）
→ 正则：`/std::bad_array_new_length/i`

**S4** 📚 `vector::reserve` / string 构造申请超大长度
```
terminate called after throwing an instance of 'std::length_error'
  what():  vector::_M_default_append
```
（what() 内容随调用点变化：`basic_string::_M_create`、`vector::_M_range_insert` 等）
→ `runtime_memory_alloc_failed`（medium）
→ 正则：`/std::length_error/i`

### 2.2 terminate 包装族

**S5** ✅ 已覆盖（现有单测）
```
terminate called after throwing an instance of 'std::out_of_range'
  what():  vector::_M_range_check: __n (which is 5) >= this->size() (which is 3)
```
→ 数组越界

**S6** 📚 `map::at` 变体
```
terminate called after throwing an instance of 'std::out_of_range'
  what(): map::at
```
→ 数组越界

**S7** 📚 自定义异常类（内层无法识别）
```
terminate called after throwing an instance of 'MyError'
  what():  something bad
```
→ 不应猜具体原因 → `runtime_unknown`（medium，比现在的 low 好——至少能说"程序抛出了未处理的异常"）
→ 正则建议：先解包 `/terminate called after throwing an instance of '([^']+)'/` 取捕获组，再对内层类名查表；查不到 → unknown(medium)

**S8** 📚 无活跃异常的 terminate（noexcept 函数抛出、线程析构时仍有异常等）
```
terminate called without an active exception
```
→ `runtime_unknown`（medium，学生化文案可提"程序内部状态异常"）
→ 正则：`/terminate called without an active exception/i`

**S9** ❓ what() 缩进/空格变体：libstdc++ 输出 `  what():  msg`（两空格），部分老版本为 `what(): msg` 单空格顶格。解包策略只看第一行类名即可规避此差异。（未逐版本验证，按"不依赖 what() 行"设计即安全。）

**S10** 📚 MSVC 无 terminate 文本，直接弹 `Debug Error!` 对话框并输出：
```
Debug Error!

Program: main.exe

abort() has been called
```
→ `runtime_unknown`（medium）；若同时无其他线索，靠 exit code 3 区分不了什么。
→ 正则：`/abort\(\) has been called/i`

### 2.3 段错误 / 非法内存访问族

**S11** ✅ 已覆盖
```
Segmentation fault (core dumped)
```
→ 段错误（medium）

**S12** ✅ 已覆盖
```
Exception 0xc0000005 ACCESS_VIOLATION writing address 0x00000000
```
→ 段错误

**S13** 📚 MSVC IDE/命令行风格
```
Unhandled exception at 0x00F41A37 in main.exe: 0xC0000005: Access violation reading location 0x00000000.
```
→ 段错误（现有 `access[ _-]?violation` 与 `0xc0000005` 双重命中，无需改）

**S14** 📚 gdb attach 风格
```
Program received signal SIGSEGV, Segmentation fault.
0x00000000004013c4 in main () at main.cpp:12
12 *p = 42;
```
→ 段错误（已覆盖）

**S15** 📚 Windows WER 弹窗路径（stderr 可能为空，仅 exit code 3221225477 = 0xC0000005）
```
(stderr 为空)
```
→ 建议：**exit code 启发式**——`exitCode === 3221225477` 且无其他模式 → 段错误（low）。同理 exit 3221225725 = 0xC00000FD 见 S18。

### 2.4 栈溢出族

**S16** ✅ 已覆盖：stderr 含 `stack overflow` 字样（MinGW/gdb 场景）
**S17** 📚 `__stack_chk_fail` / `*** stack smashing detected ***`：后者目前**不在**模式表里，注意 `stack smashing detected` 语义是栈保护检测到破坏（往往是越界写），现归类应属段错误兜底还是数组越界存疑 → 见 §5 开放问题。

**S18** 📚 Windows STATUS_STACK_OVERFLOW
```
Exception 0xc00000fd STACK_OVERFLOW ...
```
或 stderr 为空、仅 exit code 3221225725。
→ 栈溢出；正则 `/0xc00000fd|STATUS_STACK_OVERFLOW/i` + exit code 启发式。

**递归爆栈的实际表现歧义（重点讨论）**：无限递归最常见的表现是**普通段错误**——栈耗尽后碰 guard page，内核报 SIGSEGV，stderr 只有 `Segmentation fault (core dumped)`，没有任何 stack 字样。此时：
- 判「段错误」：诚实但教学价值低（学生看到"非法内存访问"会困惑，他没写指针）；
- 判「栈溢出」：更贴近真实原因，但没有证据，纯靠猜测。
**建议**：维持判段错误（诚实优先），但在段错误的详情/追问场景由 LLM 补充"常见诱因包括过深递归"。不做无证据的升级。（若未来想升级，唯一低风险信号是 exit 139 + stdout 有大量重复输出/深层打印，过于启发式，本期不建议。）

### 2.5 超时 / 等待输入

这两类由运行器标志位（`timedOut` / `needsInteractiveInput`）驱动，不走文本匹配，现状正确。典型表象补充：等待输入的程序常伴随「stdout 已输出提示语但进程不退出」；死循环超时常伴随 stdout 持续刷屏。均不需要新模式，仅作语料留档。

### 2.6 其他 abort 族

**S19** 📚 assert 失败（MSVC）
```
Assertion failed: n > 0, file main.cpp, line 24
```
→ 建议 `runtime_unknown`(medium)，文案可提"程序内的断言检查失败了"；是否单独成档见 §5。
→ 正则：`/Assertion failed/i`

**S20** 📚 SIGFPE（Linux 整数除零不会崩？——会，整数除零触发 SIGFPE；浮点除零得 0/inf 不崩）
```
Floating point exception (core dumped)
```
→ 是否单独成档见 §5；最低限度从段错误模式中排除，避免误标。
→ 正则（如立档）：`/\bSIGFPE\b|Floating point exception/i`

**S21** 📚 MSVC 纯虚函数调用
```
R6025 - pure virtual function call
```
→ `runtime_unknown`(medium)。新手出现率低，暂不建议立档，仅收录语料。

### 2.7 中文 locale 本地化差异

- **libstdc++ 运行时异常消息（terminate/what()）**：硬编码英文，无本地化机制。高置信：中文环境下 S1–S9 格式不变。
- **GCC 编译期诊断**：GCC 有 gettext 本地化框架，但 zh 中文翻译覆盖极不完整，且 MinGW-w64 发行版通常不带 .mo 文件——实践上编译诊断也是英文。❓ 未在本机 MinGW 上实测验证，标注存疑；即便存在差异也只影响编译期解析器（errorKnowledgeMap），不影响运行期分类器。
- **Windows CRT / MSVC Debug Error 对话框**：❓ 在 zh-CN 系统上部分 CRT 运行时消息（如 `Debug Error!` 标题、`abort() has been called`）**可能**随系统语言本地化为「调试错误！」「已调用 abort()」。未验证。缓解策略：对这类样本同时保留英文模式和 exit code 启发式，避免单一依赖英文文案。
- **结论**：运行期分类器的核心信号（异常类名、信号名、NTSTATUS 码）都是 locale 无关的符号，按符号建模式即可基本免疫本地化问题。

---

## 3. 核心设计题：`std::bad_alloc` 怎么归？（重点，请拍板）

### 方案 a：直接映射到「数组越界」

`std::bad_alloc` → `runtime_array_out_of_bounds`（high）。

- 利：枚举不加档；筛选 chips 不变；对学生来说最常见诱因确实就是开大数组/越界下标，直达结论。
- 弊：
  1. **证据不足却给 high 置信**。`bad_alloc` 只说明「分配失败」，也可能是内存泄漏累积、在循环里反复 new、或真要开一个合法但巨大的容器。把它标成"数组越界"是在没有下标证据的情况下替学生下了结论，与本项目"清单只是模型声明、以事实为准"的诚实原则相悖。
  2. 一旦学生真遇到泄漏型 bad_alloc，错误标签会把调试引向完全错误的方向。
  3. 未来想纠正只能改枚举语义，动文案等于改 API。

### 方案 b：新立「内存申请失败」档 + 学生化文案点明最常见诱因 ⭐ 推荐

新增 `runtime_memory_alloc_failed`，文案示例：

> 运行出错：内存申请失败（最常见原因：数组开得过大，或循环边界算错导致出现超大/负数下标）

分类规则：
- `std::bad_alloc` → 该档（medium）
- `std::length_error` → 该档（medium）
- `std::bad_array_new_length` → **仍归「数组越界」**（high）：这个异常本身就是 `new[]` 收到负数/超长参数的直接证据，越界结论成立，不该和 bad_alloc 同档。

- 利：标签诚实（说了"分配失败"这个事实），文案把最可能的诱因教给学生，两头都占；置信 medium 反映真实不确定性；后续若加"内存泄漏"等细分有挂载点。
- 弊：六类变七类，Journey 过滤栏多一颗 chip；`RUN_ERROR_KIND_LABELS`、单测、（若有）持久化历史里的旧数据展示都要跟着动一次。

### 推荐结论

**方案 b**。理由浓缩为一句话：方案 a 用 high 置信说了一个分类器证明不了的结论；方案 b 多付一颗 chip 的 UI 成本，换来标签诚实 + 教学信息不丢。用户反例的核心诉求（"让学生知道可能是数组越界引起的"）由文案承载，比由类别名承载更稳。

配套调整（无论选哪个方案都建议做）：

- **修 B3**：把 `/SIGABRT/i` 与 `/aborted[\s\S]*core dumped/i` 从段错误模式表中移出，改为独立的 abort 处理分支（见 §4）。
- **terminate 解包**（见 §4）：这是让 S1/S3/S4/S6/S7 全部受益的结构性改进，优先级高于逐条加模式。

---

## 4. 分类优先级与歧义规则

### 4.1 解包规则：terminate 包装不成类

`terminate called after throwing an instance of 'X'` 是包装层不是病因。分类流程应为：

1. 先做整体文本匹配（现有各模式表，含信号名、NTSTATUS 等）；
2. 若无命中，尝试解包：提取内层异常类名 X，查「异常类名 → kind」映射表：
   - `std::out_of_range` → array_out_of_bounds(high)
   - `std::bad_array_new_length` → array_out_of_bounds(high)
   - `std::bad_alloc` → memory_alloc_failed(medium)〔若采方案 b〕
   - `std::length_error` → memory_alloc_failed(medium)〔若采方案 b〕
   - 其他/自定义类名 → runtime_unknown(**medium**，文案可提"程序抛出了一个未被处理的异常")
3. `terminate called without an active exception` → runtime_unknown(medium)。

解包放在整体匹配之后的原因：像 S5 这种情况，内层 `out_of_range` 与 `_M_range_check` 都能整体匹配，先走老路零回归风险；解包只兜住原本会漏的尾巴。

### 4.2 优先级表（改造后的完整顺序）

| 优先级 | 条件 | 结果 | 置信 |
| --- | --- | --- | --- |
| 1 | `needsInteractiveInput` | interactive_input_needed | high |
| 2 | `timedOut` | time_limit_exceeded | high |
| 3 | 显式越界证据（`_M_range_check`、`subscript out of range`、ASan overflow、`out_of_range`、`bad_array_new_length`） | array_out_of_bounds | high |
| 4 | 显式栈溢出证据（`stack overflow`、`0xc00000fd`、`STATUS_STACK_OVERFLOW`） | stack_overflow | high |
| 5 | 显式分配失败证据（`bad_alloc`、`length_error`）〔方案 b〕 | memory_alloc_failed | medium |
| 6 | 段错误证据（`SIGSEGV`、`access violation`、`0xc0000005`、`segmentation fault`） | segmentation_fault | medium |
| 7 | abort/terminate 解包后仍无内层结论 | runtime_unknown | medium |
| 8 | exit code 启发式：3221225477 → 段错误(low)；3221225725 → 栈溢出(low) | 对应档 | low |
| 9 | 其余非零退出 | runtime_unknown | low |

要点：

- **SIGABRT 从段错误表移除**后不再有独立 abort 档：abort 只是"怎么死的"，不是"为什么死"，其信息量已由第 6/7 步承接。exit 134 本身不建议映射到任何具体档。
- 第 8 步 exit code 启发式是新增项，只在文本全空时生效，置信 low。
- `stack smashing detected`（S17）暂不进任何表，保持现状（unknown），避免在"越界写 vs 栈保护"之间武断——见开放问题。

### 4.3 兜底类的诚实性

- `runtime_unknown` 保持「运行出错：原因不明」主文案，**不猜原因**；
- medium 级 unknown（terminate 解包成功但类名陌生）可在 Journey 详情行附一句事实性描述："程序抛出了一个未被处理的异常（类型：MyError）"——只转述 stderr 出现过的内容，不推断成因；
- 详情里始终带原始 stderr 片段入口（现状已有），保证学生和老师都能看到原文。

---

## 5. 开放问题（留给用户/后续轨）

1. **bad_alloc 方案 a/b 拍板**（本文推荐 b，§3）。
2. **assert 失败是否单独成档**（S19）：新手用 assert 的频率不高，倾向先归 unknown(medium)+事实描述，等错题本数据证明高频再立档。
3. **SIGFPE 是否单独成档**（S20）：整数除零在初学者代码里不算罕见，但 Linux 才有明确文案，MinGW 下表现为 0xC0000094（INT_DIVIDE_BY_ZERO，❓未实测）。可先只加"从段错误表排除 SIGFPE 文案"的防误标，立档延后。
4. **stack smashing detected 的归属**：语义上是"检测到越界写"，归数组越界其实证据充分（`__stack_chk_fail` 意味着有人写穿了 canary），但也可能来自被调库。倾向归 array_out_of_bounds(medium)，请用户拍板。
5. **旧持久化数据的枚举兼容**：Run/Journey 历史经 ADD3 存储原语落盘，旧记录里不会有新枚举值（向后兼容无虞），但需要确认读取侧对新值有容错（旧版本扩展读到 `memory_alloc_failed` 时显示什么）。实施时补一条读回降级测试。
6. **exit code 启发式（§4.2 第 8 步）是否要做**：收益是 stderr 为空的 Windows 崩溃也能分类，代价是多一条启发式规则的维护成本。可裁剪。

## 6. 实施清单（只列不动手）

改动文件（全部位于 `code/classmate/`）：

| 文件 | 改动 |
| --- | --- |
| `src/run/runErrorKind.ts` | 〔方案 b〕+1 枚举值 `runtime_memory_alloc_failed` + 文案；`RUN_ERROR_KINDS` 同步 |
| `src/run/runErrorClassifier.ts` | 新增 ALLOC_FAILED_PATTERNS；SEGFAULT 表移除 SIGABRT 两条；terminate 解包辅助函数 + 异常类名映射表；优先级重排（§4.2）；可选 exit code 启发式 |
| `src/journey/journeyFilters.ts` | 预计零改动（默认集合展开 `RUN_ERROR_KINDS` 自动纳入）；人工验证 chips 渲染 |
| `src/chat/journeyDigestBuilder.ts` | 预计零改动（走 LABELS 表） |
| `webview/` 筛选 chips 组件 | 预计零改动，人工过一眼 |
| ADD3 存储读回路径 | 补一条未知 kind 降级容错（对应开放问题 5） |

测试增量（`src/test/runErrorClassifier.test.ts`，每档 ≥2 样本）：

- 新档：S1（用户实测原文）、S2（无 what() 变体）、S4（length_error）、泄漏型 bad_alloc 也归新档（防止将来有人改成方案 a 时丢测试）；
- 数组越界增补：S3（bad_array_new_length → array_out_of_bounds，**断言它不进新档**）；
- terminate 解包：S7（自定义类 → unknown medium，断言不再是 low、也不是段错误）、S8（without an active exception）、S9 缩进变体一条；
- 回归护栏：B3 修复的反向用例——`Aborted (core dumped)`（无其他线索）不得判段错误；现有 12 条用例预期全部不动通过；
- exit code 启发式（若采纳）：3221225477 空 stderr → 段错误(low)、3221225725 → 栈溢出(low)。

预计规模：分类器 ~40 行净增、枚举 ~3 行、测试 ~15 个 it 块；无 webview 结构改动。
