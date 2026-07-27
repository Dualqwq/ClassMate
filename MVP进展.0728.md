# ClassMate MVP 进展

> 最后更新：2026-07-27
>
> 当前版本：`0.0.4`（V4 RouteAndPlan）
>
> 最新测试版本：ClassMate `0.0.4`
>
> 当前结论：核心教学对话、LangGraph 流程、Skill 定向检索、真实工作区读取、流式回答和性能追踪已经跑通；下一阶段重点是缩短首字等待时间并完成更多人工验收。

## 1. MVP 目标

ClassMate 面向刚开始学习 C/C++、数据结构和面向对象的学生。当前 MVP 希望完成下面的闭环：

```text
打开作业
→ 读取题目和相关代码
→ 判断学生是在提问、求提示、查错误还是请求修改
→ 只加载本次回答需要的工作区文件和 Skill 小节
→ 给出符合学生水平的分层回答
→ 记录模型耗时、Token、错误和 Debug 历程
→ 学生继续修改、编译和追问
```

## 2. 当前架构

最新版使用一次 `RouteAndPlan` 和一次 `Answer` 完成主要回答流程：

```text
用户问题
→ 本地预分类和按钮类型锁定
→ RouteAndPlan（判断任务、选择文件、选择 Skill、制定回答计划）
→ 安全校验文件路径和 Skill ID
→ 一次性加载需要的工作区文件
→ 从 skill-graph.json 提取需要的 Skill 小节
→ 构建最终 Answer Prompt
→ Answer 流式输出
→ 回答层级校验
→ 记录各节点耗时和 Token
```

详细设计见 [V4 架构与流程](./docs/architecture-v4.md)。

## 3. 已完成

### 3.1 VS Code 界面

- [x] 侧边栏聊天界面
- [x] 编辑器大面板聊天界面
- [x] Markdown 和代码高亮
- [x] 多会话创建、切换和持久化
- [x] 图片、代码、文本和 PDF 附件
- [x] 文件与选区引用
- [x] 回答 Token 用量显示
- [x] 流式消息事件：`streamStart`、`appendToken`、`streamEnd`
- [x] 修正聊天区域高度和滚动布局

### 3.2 模型接入

- [x] OpenAI
- [x] Claude
- [x] DeepSeek
- [x] API Key 使用 VS Code SecretStorage 保存
- [x] OpenAI 兼容接口支持流式回答和 usage 统计
- [x] DeepSeek Cache hit/miss Token 统计
- [x] JSON Mode 只用于 RouteAndPlan
- [x] DeepSeek 规划节点关闭思考模式
- [x] 不把 DeepSeek 专用参数发送给普通 OpenAI
- [x] RouteAndPlan 与 Answer Token 累加统计

### 3.3 LangGraph V4

- [x] Router 与 Planner 合并为一次模型调用
- [x] 删除“补上下文后再次调用 Router”的最多 10 次模型循环
- [x] RouteAndPlan 使用短字段 JSON，减少输出 Token
- [x] 可选 JSON 字段缺失时由本地补默认值
- [x] 模型返回数组过长时安全截断
- [x] RequestType 在进入 Answer 前冻结
- [x] 用户明确要求第一层提示时，本地锁定 `problem_hint`
- [x] 用户明确点名的工作区文件由程序确定性加载
- [x] 路径和 Skill ID 必须存在于已提供目录，禁止越界读取
- [x] Skill Graph 失效时不会把整个参考资料库作为兜底提交
- [x] 正常 VS Code 流式回答不自动重试，避免已经显示的内容重复出现

### 3.4 Skill

- [x] 精简 `SKILL.md`，保留核心教学规则和明确目录
- [x] RouteAndPlan 获得完整精简版 `SKILL.md`
- [x] Answer 仍获得完整精简版 `SKILL.md`
- [x] 使用 `skill-graph.json` 标记可检索小节
- [x] Answer 只补充本次真正需要的小节正文
- [x] 覆盖指针、链表、动态内存、析构、深拷贝、编译错误和常见误区
- [x] 第一层提示增加长度和代码行数限制
- [x] 最终回答可读取 `CLASSMATE.md` 中允许的学习偏好

### 3.5 工作区上下文

- [x] 优先读取活动代码同目录的 `question.md`
- [x] 支持同目录 `question.pdf`
- [x] 支持带文本层 PDF
- [x] 扫描 PDF 会明确提示需要 OCR
- [x] 建立压缩工作区目录供 RouteAndPlan 选择
- [x] RouteAndPlan 不读取活动文件、题目和 Skill 正文
- [x] 最多一次性加载 5 个规划文件
- [x] 输出面板和虚拟编辑器不会替换最后一个真实代码编辑器
- [x] 支持同目录多 C/C++ 源文件编译

### 3.6 Debug 与错题本

- [x] 编译错误解析
- [x] 编译成功、求助和代码修改事件
- [x] 修改前后快照和 Diff
- [x] 错误指纹和生命周期
- [x] 知识卡片与学习统计
- [x] Debug Journey 树
- [x] Markdown Debug 错题本导出

## 4. 测试结果

### 4.1 自动化测试

最终源码在 2026-07-27 完成以下检查：

- TypeScript 测试编译：通过
- 扩展端 Webpack 构建：通过
- Webview esbuild 构建：通过
- ESLint：0 error，0 warning
- VS Code 扩展测试：150 passing
- `src`、`webview`、`skill`：共检查 114 个文件
- VSIX 内部版本和必要运行文件：检查通过

主要回归测试覆盖：

- RouteAndPlan 紧凑输入和安全默认值
- Skill Graph 校验和小节提取
- 工作区路径白名单
- 任务类型冻结
- 第一层提示不输出完整程序
- DeepSeek 思考模式参数
- Answer 强制使用流式适配器
- RouteAndPlan 与 Answer Token 累加

### 4.2 真实 API 测试

测试工作区：本地“指针/链表”测试题目录

模型：`DeepSeek-V4-Flash`

测试问题包括：

1. `at(-1)` 为什么会无限循环或崩溃。
2. 简单解释 C++ 指针并给出短例子。
3. `insert_after` 和内存泄漏只给第一层提示。

三次最终测试均满足：

- 回答引用真实工作区代码。
- 没有虚构未加载的代码。
- 第一层提示没有给完整替换程序。
- 回答校验通过。
- 没有进入 fallback。
- Webview 收到了流式回答事件。

平均性能：

| 指标 | 平均值 |
|---|---:|
| 总耗时 | 17.51 秒 |
| RouteAndPlan | 4.76 秒 |
| Answer | 12.59 秒 |
| 首个可见回答片段 | 13.80 秒 |
| 输入 Token | 7,217 |
| 输出 Token | 957 |
| 总 Token | 8,174 |

详细记录见 [性能测试记录](./docs/performance-notes.md)。

## 5. 当前已知问题

### P1：优先处理

| 编号 | 问题 | 原因 | 下一步 |
|---|---|---|---|
| MVP-014 | 流式回答看起来像一次性出现 | 普通 Answer 没有关闭 DeepSeek 思考模式；插件只显示 `content`，不显示前面的 `reasoning_content` | 按任务复杂度选择思考模式：概念、短问答和提示关闭；复杂调试按需开启 |
| MVP-015 | 首字等待仍然偏长 | RouteAndPlan 需要先完成；Answer 的服务端思考阶段也可能持续数秒 | 增加“正在判断任务/读取文件/组织回答”状态，并继续压缩 Answer 上下文 |
| MVP-016 | 单次总 Token 仍约 8k | 完整 `SKILL.md`、Skill 小节、工作区文件和历史需要同时进入 Answer | 保留完整 `SKILL.md` 的前提下，减少重复规则并对历史按 Token 预算裁剪 |

### P2：功能完善

| 编号 | 问题 | 当前状态 |
|---|---|---|
| MVP-006 | 缺少题目文件时的界面引导还不够明显 | 部分完成 |
| MVP-008 | 扫描 PDF 和图片不能本地 OCR | 待实现 |
| MVP-009 | 自动代码修改只支持当前文件 | 待实现跨文件修改 |
| MVP-011 | Makefile 尚未作为专门的构建上下文处理 | 待实现 |
| MVP-012 | `CLASSMATE.md` 仍缺少面向初学者的生成界面 | 待实现 |
| MVP-017 | Webview 缺少 Content Security Policy | 扩展宿主会给出警告，需要补 CSP |

### 不影响运行的工程问题

- `package.json` 还没有 `repository` 字段。
- 项目还没有 LICENSE 文件。
- Git 会提示部分文件将来可能从 LF 转换成 CRLF。
- VS Code Insiders 测试宿主会输出 Mermaid proposal、GitHub token 和 Node `url.parse()` 警告，这些不是 ClassMate 源码错误。

## 6. 下一步建议顺序

1. 修复“看起来不是流式输出”：根据任务类型控制 DeepSeek 思考模式。
2. 在等待 RouteAndPlan 和 Answer 首字期间显示当前节点状态。
3. 重新跑三类真实问题，比较首字时间、总时间、回答质量和 Token。
4. 为 Webview 增加严格 CSP。
5. 完成缺题引导、Makefile 上下文和 `CLASSMATE.md` 简单配置界面。
6. 再处理 OCR 和跨文件自动修改。

## 7. MVP 验收标准

- [x] 能读取题目、活动代码和明确点名的文件。
- [x] 能区分按钮请求和普通对话。
- [x] 能区分概念、提示、编译错误、运行错误、代码解释和普通聊天。
- [x] 第一层提示不会直接给完整程序。
- [x] RouteAndPlan 只使用目录，不读取文件正文。
- [x] Answer 获得完整 `SKILL.md` 和选中的 Skill 小节。
- [x] 文件路径和 Skill ID 有白名单校验。
- [x] 支持 OpenAI、Claude 和 DeepSeek 适配器。
- [x] 支持流式事件、取消和错误提示。
- [x] 记录节点耗时和完整流程 Token。
- [x] 真实指针/链表题目 API 回归通过。
- [x] 150 个自动化测试通过。
- [x] 已生成并安装版本 `0.0.4`。
- [ ] 普通回答的首字流式体验达到人工验收要求。
- [ ] 编译、运行、修改、重新编译的完整 Debug 闭环通过人工验收。
- [ ] 导出的错题本只包含当前题目。
- [ ] 缺少题目、API Key 或 `g++` 时均有清晰的界面提示。

## 8. 当前保留的交付文件

- `docs/architecture-v4.md`：当前流程设计。
- `docs/performance-notes.md`：最终真实 API 性能记录。
- `MVP进展.0723.md`：当前整体进度和待办。
- GitHub Release 中的 `classmate-0.0.4.vsix`：当前可安装版本。

历史流程草稿、旧 VSIX、旧测试计划和脚手架说明已清理，不再作为当前交付内容。
