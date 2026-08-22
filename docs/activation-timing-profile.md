# ClassMate 激活(Activating)耗时计时剖析与基线报告

> 测量日期：2026-08-21
> 用途：#15「优化 Activating 耗时」的前置度量——先出基线再定目标值，没有度量不开工。
> 范围：只读剖析，不含任何生产代码改动。被测代码为 worktree `docs/timing-profile` @ `a54173c`(与 `after-0803` 主线同码)。
> 结论速览：激活耗时 **p50 ≈ 83 ms(生产包)/ 108 ms(开发包)**,其中约 70–80% 是 **bundle 字节的读盘 + V8 编译**,`activate()` 函数体本身只占 ~5 ms。优化主杠杆是缩小入口 bundle(惰性化问答期依赖),不是精简注册逻辑。
> 拍板状态(2026-08-21):**#15 任务已完成**。用户拍板当前激活速度(p50≈83 ms)足够优秀，不追 §5 进取目标、不改图执行链装配、不动架构;§6 开放问题全部关闭，本文档留作基线存档。

## 1. 方法论

### 1.1 测量对象与环境

- 被测扩展:`a54173c`,webpack 构建产物 `dist/extension.js`,两种形态分别测量：
  - **dev 包**(`npm run compile:ext`,mode=none，未压缩，8 MB,含 742 个 node_modules 模块 + 89 个 src 模块);
  - **prod 包**(`npx webpack --mode production`,压缩后 4 MB,与 VSIX 发布形态一致)。
- 环境：Windows,Intel Core Ultra 7 258V,31.5 GB RAM;VS Code 1.128.0(`.vscode-test` 缓存版本),扩展宿主 Node v24.17.0。
- 测试工作区:`test_directory_bug1/`(8 个文件，典型小型 C++ 作业目录)。
- 每轮测量启动一个全新 VS Code 实例，使用全新临时 `--user-data-dir`/`--extensions-dir`(干净 profile，无其他第三方扩展),打开测试工作区后由探针触发激活。

### 1.2 测量口径

计时入口是扩展宿主内的 `vscode.extensions.getExtension(...).activate()` 墙钟耗时，与 VS Code「Developer: Show Running Extensions」所报激活耗时同口径(**模块加载 + `activate()` 执行**,不含扩展宿主进程本身的启动)。

三种探针模式(均为一次性脚本，不入库，见 §7):

- `activate`:`ext.activate()` 总耗时，多轮取分布(主基线)。
- `profile`:同进程 `inspector.Session` CPU 采样(200 µs 间隔)覆盖激活全程，再用 `dist/extension.js.map` 把采样点还原到原始源文件做归因。
- 临时插桩：在 `src/extension.ts` 的 `activate()` 体内插入 15 个 `performance.now()` 计时点，测各注册阶段耗时与 fire-and-forget 后台任务的完成时刻;**测完已 `git checkout` 还原，未入库**。

### 1.3 已知局限

- CPU 采样自身开销约占采样总量的 ~27%(`node:inspector` 帧),profile 轮的绝对值(≈136 ms)比干净轮(≈108 ms)偏高；归因只看相对比例。
- 干净 profile 每轮新建，测的是"接近首次启动"的场景;§3.3 另测了共享 profile 的暖启动。
- 仅测 Windows + VS Code 1.128;macOS/Linux 与其他 VS Code 版本未覆盖。
- bundle 内执行时间有 ~55% 的采样点无法被 source-map 映射(tslib 内联助手与 webpack 模块工厂包装),按包归因以可映射部分为准。

## 2. 静态分析：激活链路上的重活候选

### 2.1 activationEvents(package.json:25-46)

19 个触发点，全部是 `onLanguage:c/cpp`、`onView:*`、`onCommand:*`;**没有 `*` 或 `onStartupFinished`**。激活时机本身已是惰性的——用户打开 C/C++ 文件或 ClassMate 视图才激活。这一侧没有可省的触发器。

### 2.2 activate() 同步体(src/extension.ts:769-1226)

按执行顺序的重活候选与实测定位:

| 阶段 | 内容 | 性质 |
|---|---|---|
| 模块加载 | 8 MB(dev)/4 MB(prod)bundle 读盘 + V8 编译 + 742 个 node_modules 模块工厂执行(`@langchain/*`、`openai`、`@anthropic-ai/sdk`、`zod`、`pdf-parse`、`gray-matter` 等全部随入口静态打入) | **同步，主成本** |
| `ChatSession.getInstance()` | 单例字段初始化 | 微秒级 |
| `DebugJourneyStore` / `ConversationDiagnosticRecorder` 构造 | 仅拼路径，无 I/O | 微秒级 |
| `new WorkspaceContextProvider()` | 同步创建 **5 个 FileSystemWatcher** + 3 个窗口/文档事件监听 | ~1–2 ms |
| `context.workspaceState.get(chatStorageKey)` | 聊天持久化数据同步读(Memento 已反序列化) | 亚毫秒 |
| skill / graph 各 loader 构造 | `SkillContentLoader`、`SkillGraphLoader`、`ProblemCardIndexLoader` 等 | 全惰性，微秒级 |
| webview/treeview/20 个命令/2 个 CodeLens/2 个状态栏注册 | VS Code API 注册 | 各亚毫秒 |
| `web-tree-sitter` | webpack external，随 bundle `require`(~2 ms);`Parser.init` 与 4 MB wasm **惰性**,首次问答才加载，不在激活路径 | 小 |

### 2.3 fire-and-forget(不计入激活耗时，但激活后立即占用宿主 CPU)

- `workspaceProvider.refresh()`(extension.ts:816):`findFiles` 全工作区 glob(上限 2000 文件)+ 逐文件 `stat` + 读题目文件，实测完成于激活后 ~60–90 ms。
- `getLLMConfig` / `getFallbackLLMConfig`(extension.ts:956-960):2 次 SecretStorage + 若干 globalState 读，实测完成于激活后 ~25–75 ms。
- `DebugJourneyTreeProvider` 构造时 `void this.load()`(读 events.jsonl)。
- `promptToEnableCodeLens`(globalState 读)。

这些不挡 `activate()` 返回，但决定"激活后多久真正可用"。

### 2.4 理论排序假设(已被 §4 证实)

bundle 读盘+编译 ≫ 模块工厂执行 > activate() 体 ≫ 其余注册项。

## 3. 基线数字

### 3.1 总激活耗时(n=10,干净 profile,全新 VS Code 实例)

| 构建形态 | min | p50 | mean | p90 | max |
|---|---|---|---|---|---|
| dev 包(8 MB) | 105.3 | **107.7** | 109.3 | 118.0 | 118.0 |
| **prod 包(4 MB,VSIX 形态)** | 79.2 | **83.2** | 84.3 | 103.2 | 103.2 |

原始数据:dev `[105.3, 105.4, 105.6, 106.5, 106.5, 107.7, 107.9, 113.3, 116.8, 118.0]`;prod `[79.2, 79.5, 81.5, 82.8, 83.2, 83.2, 83.5, 83.5, 83.5, 103.2]`。

体积减半(8→4 MB)省 ~24 ms，激活耗时对 bundle 字节数近似线性——这是 §5 目标值的依据。

### 3.2 activate() 体内分阶段(临时插桩，n=5,dev 包)

体总耗时(start→end)中位 **≈5.8 ms**(区间 4.8–23.7 ms，离群轮伴随系统噪声)。各阶段均亚毫秒到 1–2 ms：创建 watcher 组 ~1.4 ms、20 个命令注册 ~0.7 ms、其余注册 <0.5 ms。**activate() 体不是瓶颈，精简它没有收益。**

后台任务完成时刻(相对激活开始，中位):`llmConfig.done` ≈ +33 ms,`workspaceRefresh.done` ≈ +78 ms,`fallbackLLMConfig.done` ≈ +5 ms。

### 3.3 暖启动(共享 user-data,n=8,dev 包)

`[142.8, 180.0, 121.5, 169.1, 284.9, 122.5, 245.0, 125.4]`,中位 169 ms——**没有变快，反而更慢更抖**。共享 profile 下 workbench 会话恢复(重建编辑器、视图状态)与激活抢 CPU，淹没了可能存在的 V8 code cache 收益。结论：指望运行时缓存自动兜底不成立，减体积才是确定性收益。

## 4. 瓶颈定位(CPU profile 归因，3 轮采样合计 561.8 ms)

| 类别 | 耗时 | 占比 | 说明 |
|---|---|---|---|
| `node:internal/modules/cjs/loader` | 262.4 ms | 46.7% | require 路径：读 8 MB bundle + V8 解析/编译(`Module._compile`)——**激活的主成本** |
| `node:inspector` | 153.3 ms | 27.3% | 采样器自身开销(测量 artifact，非真实成本) |
| `dist/extension.js` 内执行 | 62.7 ms | 11.2% | 模块工厂执行(按包归因见下) |
| 内建/GC(无 url) | 41.3 ms | 7.3% | |
| `node:fs` | 21.7 ms | 3.9% | 读盘 |

bundle 内执行(3 轮合计 62.7 ms，即每轮 ~21 ms)按包归因(可映射部分):

| 包 | selfMs | 备注 |
|---|---|---|
| `zod` | 13.2 | 入口即执行大量 schema 类定义 |
| `esprima` | 3.6 | gray-matter 的传递依赖 |
| webpack runtime | 3.8 | |
| `src/extension.ts` | 3.4 | ≈ activate() 体，与插桩结果互证 |
| `@langchain/core` | 1.7 | |
| 其余(gray-matter/js-yaml、p-queue、diff、src 各模块) | <2 各 | 长尾 |

**瓶颈结论**:ClassMate 的激活耗时不是"某个依赖执行慢",而是"太多字节要读要编译"。`@langchain/langgraph`、`openai`、`@anthropic-ai/sdk`、`zod`、`pdf-parse`、`gray-matter` 等问答期才用的模块全部静态打入入口 bundle;即便单个执行不慢，它们的字节共同构成了读盘+编译的主成本。

## 5. 优化目标值建议

> 2026-08-21 拍板：不采纳本节进取目标(不做动态 import 改造、不动架构),#15 以「维持现状」结案;本节分析留档。

依据：激活耗时 ≈ 读盘+编译 bundle 字节的成本，对体积近似线性(§3.1)。src 自有代码 629 KiB,prod 主 chunk 4 MB 中约 85% 是依赖。

- **进取目标(推荐)**:把问答期依赖(`@langchain/*`、`openai`、`@anthropic-ai/sdk`、`zod`、`pdf-parse`、`gray-matter` 等)从入口静态图改为首次问答时动态 `import()`,主 chunk 压到 ~1 MB 量级。**目标:prod 干净 profile p50 ≤ 40 ms,p90 ≤ 60 ms。** 依据：体积 4 MB→1 MB 按线性外推省 ~60 ms;p50 83 ms − 60 ms ≈ 25–40 ms 区间，取上限留余量。
- **保守目标(不动架构)**:维持 prod p50 ≤ 85 ms、p90 ≤ 105 ms,即当前 VSIX 形态基线，作为回归门禁即可。
- **不建议的方向**:精简 activationEvents(已全惰性)、拆分/延后 activate() 体内的注册逻辑(体仅 ~5 ms，收益≈0)、把 tree-sitter wasm 移出激活路径(本来就在，无需动)。
- 后台任务(refresh ~78 ms、llmConfig ~33 ms)不挡激活；若要优化"激活后首条消息可用时间",应另立度量，不混入激活目标。

## 6. 开放问题(2026-08-21 已全部关闭)

> 2026-08-21 拍板：#15 任务直接标记为已完成——当前激活速度(p50≈83 ms)足够优秀，不追 40 ms 进取目标、不改图执行链装配、不动架构。以下 5 项据此全部关闭。

1. **目标口径**:以"干净 profile 冷启动 p50"为准(可复现、噪声小),还是要覆盖"会话恢复"场景(121–285 ms,噪声主导)?建议前者做门禁，后者只做观察。**已关闭：拍板维持现状**——不设目标值门禁，基线数字仅留档。
2. **是否接受架构改动**:为达成 ≤40 ms 需把图执行链改动态 import,触及 `ChatSession`/graph 装配代码；若不接受，目标只能定在维持现状(≤85 ms)。**已关闭：拍板维持现状**——不接受架构改动，不改图执行链装配。
3. **门禁用哪个构建形态**:建议用 prod 包(与 VSIX 一致);dev 包数字仅开发参考。**已关闭：拍板维持现状**——不设门禁，无构建形态选型问题。
4. **探针是否固化**:当前驱动/探针/分析脚本为一次性，放 `log/` 不入库；是否要在后续优化分支里固化为可重复跑的 `scripts/`(类似 `eval:review`)?**已关闭：拍板维持现状**——不固化，脚本维持 `log/` 一次性形态不入库。
5. **后台任务口径**:SecretStorage 读取(~33 ms)与工作区 refresh(~78 ms)是否计入"激活后可用时间"指标，还是维持 fire-and-forget 现状不考核?**已关闭：拍板维持现状**——不考核后台任务，维持 fire-and-forget 现状。

## 7. 原始数据与脚本位置(均不入库)

`智理杯/log/` 下:

- `timing-activate-runs.json`(dev×10)、`timing-activate-prod-runs.json`(prod×10)、`timing-warm-runs.json`(暖启动×8)、`timing-phases-runs.json`(插桩×5,含各阶段 marks)、`timing-split-runs.json`、`timing-profile-runs.json`
- `timing-cpuprofile-*.json`(3 份 V8 CPU profile)
- `timing-driver.mjs`(测量驱动)、`timing-probe-host.cjs`(宿主内探针)、`timing-instrument.mjs`(临时插桩器)、`timing-analyze-profile.mjs`(profile 归因)、`timing-dev-extension.js.bak`(dev bundle 备份)

复现方式：`node log/timing-driver.mjs <activate|split|profile> <轮数> <输出.json> [reuse]`(需 worktree 已 `npm run compile:ext`,VS Code 1.128 缓存在主检出 `.vscode-test/`)。

## 8. 2026-08-22 本轮复测（after-0803 @ 3b4eeed，含 Run 面板/GBK 解码等新增功能）

> 测量分支：`perf/activating-profile`（从 `after-0803` 切出）。
> 测量方式：扩展内建 `ActivationProfiler` + `src/test/activationProfile.test.ts` 在 vscode-test 环境中自动抓取。
> 构建形态：dev/test bundle（`extension.js` 8.12 MB，与 2026-08-21 dev 包同量级）。

### 8.1 基线数字（`npm run test` 官方单次跑，vscode-test 隔离用户目录）

| 指标 | 值 |
|---|---|
| `activate()` 体 profile total | **31.464 ms** |
| 外部 `extension.activate()` 墙钟 | 0 ms（测试套件激活由前置测试触发，profile 仍记录首次真实激活） |
| 构建版本 | 0.0.5 |

> 波动性说明：同分支连续三次 vscode-test 跑测分别录得 122.453 ms / 149.715 ms / 31.464 ms，差异主要来自测试宿主 CPU 调度与文件系统缓存；31 ms 为最近一次 `npm run test` 全绿结果，122 ms 为首次干净 run 的保守观察值。

### 8.2 阶段拆分（`npm run test` 官方跑）

| Phase | ms |
|---|---|
| output-channel-created | 0.046 |
| code-lens-prompt-fired | 0.186 |
| chat-session-created | 0.187 |
| performance-sink-set | 0.014 |
| diagnostics-ready | 0.537 |
| workspace-provider-ready | 3.825 |
| persistence-configured | 0.492 |
| reference-handlers-set | 0.025 |
| graph-services-ready | 0.354 |
| chat-view-registered | 1.421 |
| debug-journey-registered | 5.167 |
| llm-config-wired | 5.779 |
| run-service-created | 0.307 |
| commands-registered | 9.956 |
| compile-output-provider-registered | 0.501 |
| inline-explain-registered | 1.990 |
| status-bars-ready | 0.597 |

### 8.3 关键观察

- `commands-registered`（~10–37 ms）与 `debug-journey-registered`（~3–34 ms）占 `activate()` 体的大头，其余阶段均 <10 ms。
- 与 2026-08-21 同口径 dev 包中位 ≈108 ms 相比，本轮 `activate()` 体仍在同一量级；bundle 读盘+V8 编译仍是主成本（不在 `activate()` 体内，未计入 profile total），与 §4 结论一致。
- 波动主要受测试宿主负载影响，不代表代码回归。

### 8.4 实现说明

- 新增 `src/activationProfiler.ts`：提供 `ActivationProfiler` 与 `getActivationProfile()`。
- `activate()` 内插 16 个 `mark`，在返回前调用 `profiler.finish()`；结果写入已有的 `ClassMate Performance` 输出通道。
- 生产包（`ExtensionMode.Production`）强制关闭；开发/测试包默认开启，可通过 `classmate.activationProfiling` 设置关闭。
- 新增 `src/test/activationProfile.test.ts` 自动抓取 profile 并生成 `benchmark/activation-baseline-latest.{json,md}`（已加入 `.gitignore`，每次跑测试刷新）。

### 8.5 目标值建议（待人审拍板）

- 维持现状派：沿用 2026-08-21 拍板，不追进取目标；将当前 dev/test total **≈31–122 ms（负载波动）** 作为观察基线，prod 等效估计仍 **≈83–95 ms**。
- 保守门禁派：设 dev/test `activate()` 体 total ≤ **150 ms** 作为回归门禁，阻止同步逻辑明显劣化。
- 由于 2026-08-21 已决定不做动态 import 改造，本轮不再提出 ≤40 ms 进取目标。
