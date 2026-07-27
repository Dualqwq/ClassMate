# ClassMate

ClassMate 是一款面向 C/C++、程序设计基础与 OOP 初学者的 VS Code AI 学习助手。

它会结合当前工作区、题目文件、选中的代码和教学 Skill，为学生提供分层提示、概念讲解、错误分析与代码修改建议。当前版本为 `0.0.4`。

## 主要功能

- 在侧边栏或编辑器面板中进行 AI 学习对话；
- 解释 C/C++ 代码、基础语法、数据结构和 OOP 概念；
- 分析编译错误、运行错误、错误输出与 OJ 失败；
- 根据 `question.md`、`question.pdf`、源代码和 Makefile 加载所需上下文；
- 使用 LangGraph 执行任务分类、上下文选择、Skill 检索和回答生成；
- 支持流式回答，并在模型输出前显示当前处理阶段；
- 支持 OpenAI、Anthropic Claude、DeepSeek 和兼容接口；
- 记录 Debug Journey，并导出 Markdown 错题本；
- 对代码修改提供预览、冲突检查和用户确认。

## 环境要求

- VS Code `1.125.0` 或更高版本；
- Node.js 20 或更高版本；
- npm；
- 如需使用内置编译功能，需要安装 `g++` 并加入系统 `PATH`。

## 从源码开始

```bash
git clone <你的仓库地址>
cd ClassMate
npm ci
npm run compile
```

在 VS Code 中打开项目并按 `F5`，即可启动 Extension Development Host。

## 常用命令

```bash
# 编译扩展端和 Webview
npm run compile

# TypeScript 测试编译
npm run compile-tests

# 代码规范检查
npm run lint

# 运行 VS Code 扩展测试
npm test

# 生成生产构建
npm run package

# 生成 VSIX
npx vsce package
```

第一次执行 `npm test` 时，测试工具可能需要下载 VS Code 测试运行环境。

## 安装 VSIX

1. 执行 `npx vsce package`；
2. 在 VS Code 中打开扩展页面；
3. 点击右上角的 `...`；
4. 选择 `Install from VSIX...`；
5. 选择生成的 `.vsix` 文件。

## 配置模型

打开 ClassMate 聊天窗口中的设置面板，填写：

- 模型提供商；
- 模型名称；
- API Key；
- 可选的自定义 API URL。

也可以在命令面板中执行：

```text
ClassMate: Set API Key
```

API Key 使用 VS Code Secret Storage 保存，不会写入仓库文件。请不要把真实密钥放入源码、测试、Issue 或提交记录中。

## 工作区上下文

ClassMate 当前可以发现并按需读取：

- C/C++ 源文件和头文件；
- `question.md`、`question.pdf`；
- `CLASSMATE.md`；
- Markdown 和纯文本文件；
- `Makefile`、`makefile`、`GNUmakefile`、`*.mk`。

规划阶段只接收精简目录，不接收所有文件正文。控制器会验证模型选择的路径、限制文件数量与大小，并只加载允许范围内的内容。

## 项目结构

```text
.
├─ .github/workflows/      GitHub Actions
├─ .vscode/                F5 调试与构建任务
├─ docs/                   架构、进展和性能说明
├─ skill/classmate/        教学 Skill、引用资料与 Skill Graph
├─ src/
│  ├─ chat/                对话状态和消息处理
│  ├─ compiler/            C/C++ 编译与运行
│  ├─ config/              模型及密钥配置
│  ├─ debug/               Debug Journey 与错题本
│  ├─ graph/               LangGraph 主流程
│  ├─ llm/                 模型适配器
│  ├─ prompts/             规划和回答提示构造
│  ├─ skill/               Skill Graph 检索与小节提取
│  ├─ test/                自动化测试
│  ├─ ui/                  VS Code 视图
│  └─ workspace/           工作区目录、文件加载与安全限制
└─ webview/                React 聊天界面
```

## 设计文档

- [V4 架构与流程](docs/architecture-v4.md)
- [MVP 开发进展](MVP进展.0728.md)
- [性能测试记录](docs/performance-notes.md)

## 隐私与安全

- API Key 只保存在 VS Code Secret Storage；
- 工作区文件必须先进入受控目录，模型才能请求读取；
- 拒绝绝对路径、目录穿越、超大文件和不支持的类型；
- 代码修改在真正写入前会进行结果校验和文件冲突检查；
- Debug Journey 数据保存在本地扩展存储中。

## 当前状态

这是仍在迭代的早期版本。已知事项和后续计划请查看 [MVP 开发进展](MVP进展.0728.md)。

## License

当前仓库尚未指定开源许可证。在添加许可证之前，默认不授予复制、修改或分发代码的权利。仓库所有者应在公开发布前选择合适的许可证。
