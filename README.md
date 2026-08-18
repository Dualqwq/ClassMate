# ClassMate

## 导出完整对话诊断

需要比较真实插件与自动评测时，可在命令面板执行
`ClassMate: Export Conversation Diagnostics`，也可以直接在聊天框输入：

```text
//export-diagnostics bug1-real.json
```

相对路径默认写入项目根目录的 `log/`；不写文件名时会自动生成带时间的 JSON 文件。
导出内容包括：

- 当前工作区保存的全部聊天会话和消息；
- 每轮真实传入图的用户文本、前端 intent、会话历史和活动编辑器缓冲区；
- 每次模型调用的节点标签、完整 messages、模型选项、原始响应和 usage；
- 每个图节点执行前后的完整状态、顺序、耗时和错误；
- 冻结工作区快照、最终答案、兜底类型和异步引用提取结果。

API key、Authorization、密码等凭据字段会在写盘前剔除。诊断文件仍然包含学生对话、
附件文字和工作区源码，只应保存在本机或交给可信的项目维护者。从本版本开始产生的图事件
可以完整导出；更早已经持久化的对话只能导出消息正文，无法补回当时未记录的节点状态。

ClassMate 是一款面向 C/C++、数据结构、程序设计基础和 OOP 初学者的 VS Code AI 学习助手。当前版本为 `0.0.5`。

它可以帮助学生理解题目、寻找解题思路、读懂代码和分析编译错误。回答会尽量从提示开始，逐步增加细节，而不是一开始直接给出完整答案。

## 主要功能

### AI 学习对话

在 VS Code 侧边栏中直接提问，支持：

- 题意和解题思路提示；
- C/C++ 与 OOP 知识点讲解；
- 代码逻辑解释；
- 编译错误和 Debug 建议；
- OJ 错误排查；
- 结合题目目录和结构化知识卡片分析常见数据结构作业；
- 在模型输出前显示当前处理阶段，并在回答后展示实际读取的文件；
- Markdown 错题总结。

### 选中代码解释

在编辑器中选中一段代码，点击选区上方的 `Explain`，ClassMate 会解释代码的整体作用、关键语句和相关知识点。

### 编译与错误解释

ClassMate 可以调用本机 `g++`：

- 编译当前 C++ 文件；
- 编译成功后运行程序；
- 展示编译输出和错误位置；
- 解释选中的 GCC/G++ 编译错误。

使用编译功能前，需要安装 `g++` 并将其加入系统 `PATH`。

### Debug 历程与错题本

插件会在本地记录编译结果、求助过程和代码修改。用户可以查看 Debug Journey，并手动导出 Markdown 错题本，用于复习错误原因、相关知识点和修改过程。

### 多模型支持

当前支持：

- OpenAI；
- Anthropic Claude；
- DeepSeek；
- 自定义模型名称和 API 地址。

## 如何使用

### 1. 安装插件

1. 打开 VS Code 的扩展页面；
2. 点击右上角的 `...`；
3. 选择 `Install from VSIX...`；
4. 选择本地生成的 `classmate-*.vsix`；
5. 安装完成后重新加载 VS Code。

### 2. 打开对话

点击 VS Code 活动栏中的 ClassMate 图标，或者在命令面板中执行：

```text
ClassMate: Open Chat
```

然后可以直接输入问题，例如：

```text
我没思路，先给我一个方向。
```

```text
类和对象有什么区别？
```

#### 对话框按钮说明

对话框顶部和输入框上方的小按钮作用如下：

| 按钮 | 作用 |
|---|---|
| `Open Chat in Panel`（展开图标） | 将对话从侧边栏打开到编辑器面板，适合阅读较长的讲解 |
| `Hide Chat`（向下箭头） | 收起当前对话视图 |
| `⛶` | 将侧边栏对话切换到编辑器面板 |
| `☰` | 将编辑器面板中的对话移回侧边栏 |
| `LLM Settings`（设置图标） | 配置模型、API Key 和 API URL |

将鼠标停留在按钮上，也可以查看对应的功能提示。

### 3. 解释代码

1. 在编辑器中选中代码；
2. 点击选区上方的 `Explain`；
3. 在 ClassMate 对话窗口中查看解释。

### 4. 编译和解释错误

1. 打开一个 C++ 文件；
2. 执行 `ClassMate: Compile` 或 `ClassMate: Compile & Run`；
3. 如果编译失败，在编译输出中选中错误；
4. 点击 `Explain` 查看错误原因和修改建议。

### 5. 导出错题本

打开 ClassMate 侧边栏中的 Debug Journey，可以查看编译、求助和代码修改记录。Debug Journey 顶部按钮的作用如下：

| 按钮 | 作用 |
|---|---|
| `Refresh Debug Journey`（刷新图标） | 重新读取并刷新当前调试记录 |
| `Close Debug Journey`（关闭图标） | 关闭或收起 Debug Journey 视图 |
| `Export Debug Notebook`（导出图标） | 将当前记录整理并导出为 Markdown 错题本 |

完成 Debug 后，可以点击导出按钮，也可以在命令面板中执行：

```text
ClassMate: Export Debug Notebook
```

选择保存位置后，插件会生成并打开 Markdown 错题本。

## 如何配置 API

首次使用 AI 对话前，需要配置模型和 API Key。

### 在聊天窗口中配置

1. 打开 ClassMate 对话窗口；
2. 点击输入框上方的设置按钮；
3. 选择 `OpenAI`、`Claude` 或 `DeepSeek`；
4. 填写模型名称；
5. 填写 API Key；
6. 如使用兼容接口，填写自定义 API URL；
7. 点击 `Save` 保存。

### 清华同学领取并使用算力资源

清华大学的同学可以通过 EasyCompute 领取一定的算力资源，并使用大模型平台提供的 API：

1. 登录 [EasyCompute](https://easycompute.cs.tsinghua.edu.cn/login)；
2. 按照平台提示领取算力资源；
3. 进入“**大模型广场 → API 密钥**”；
4. 点击新建 API 密钥，并保存生成的密钥；
5. 打开 ClassMate 的模型设置；
6. 将生成的密钥填入 `API Key`；
7. 将 API 密钥页面上方显示的地址填入 `API URL`，当前地址为：

```text
https://llmapi.paratera.com
```

模型名称需要填写 EasyCompute 大模型广场中所选模型对应的名称。如果平台页面显示的 API URL 或模型名称发生变化，请以页面上的最新信息为准。

### 通过命令配置

也可以打开 VS Code 命令面板并执行：

```text
ClassMate: Set API Key
```

API Key 会保存在 VS Code 的 Secret Storage 中，不会直接写入项目文件。

## 从源码运行

```bash
git clone https://github.com/Dualqwq/ClassMate.git
cd ClassMate
npm ci
npm run compile
```

在 VS Code 中打开项目并按 `F5`，即可启动 Extension Development Host。

常用检查命令：

```bash
npm run compile-tests
npm run lint
npm test
npm run package
```

## V5 文档

- [V5 架构](docs/architecture-v5.md)
- [题目知识卡片设计](docs/problem-knowledge-v5.md)
- [V5 MVP 进展](MVP进展.V5.md)

## 隐私与安全

- API Key 只保存在 VS Code Secret Storage；
- 模型只能读取控制器验证并放入上下文的工作区文件；
- 绝对路径、目录穿越、超大文件和不支持的文件类型会被拒绝；
- 题目知识卡片只作为提示，最终回答仍需以实际题面和代码为准。

## License

当前仓库尚未指定开源许可证。在添加许可证之前，默认不授予复制、修改或分发代码的权利。
