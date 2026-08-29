# ClassMate

> 面向 C/C++ 与数据结构初学者的 VS Code AI 学习助手。当前版本 `0.1.0`。

ClassMate 不直接给你完整答案，而是先给提示、再逐步展开细节，帮你真正理解题目、代码和错误。

## 适合谁用

- 正在学习 C/C++、程序设计基础、数据结构或 OOP 的同学。
- 希望边写代码边问问题，不想频繁切换窗口或网页。
- 需要有人帮忙看懂编译错误、梳理 Debug 思路、整理错题本。

## 安装

1. 下载或编译生成 `classmate-*.vsix` 文件。
2. 打开 VS Code，进入**扩展**页面。
3. 点击右上角 `…`，选择 **Install from VSIX…**。
4. 选中 `classmate-*.vsix`，安装完成后重新加载窗口。

## 第一次使用：配置模型

ClassMate 需要一个大模型 API 才能进行 AI 对话。首次打开对话时会提示配置：

1. 点击侧边栏 ClassMate 图标，或按 `Ctrl+Shift+P` 执行 `ClassMate: Open Chat`。
2. 点击输入框上方的设置按钮，进入 **LLM Settings**。
3. 选择模型类型（OpenAI / Claude / DeepSeek / Custom），填写模型名称、API Key 和 API URL。
4. 点击保存。

API Key 会保存在 VS Code 的 Secret Storage 中，不会写入项目文件。

> 清华大学同学可通过 [EasyCompute](https://easycompute.cs.tsinghua.edu.cn/login) 领取算力资源，API URL 通常为 `https://llmapi.paratera.com`，具体以平台页面为准。

## 核心功能

### AI 学习对话

在 VS Code 侧边栏直接提问，例如：

- “我没思路，先给我一个方向。”
- “类和对象有什么区别？”
- “这段代码为什么死循环？”

ClassMate 会结合你当前打开的文件和项目上下文作答，回答前会显示当前处理阶段，回答后会列出实际读取了哪些文件。

### 基于工作区的教导

ClassMate 能识别你工作区里的题目结构、源码文件和编译结果，给出贴近当前作业的提示，而不是泛泛而谈。对话时它会自动参考：

- 当前打开的 C/C++ 文件；
- 项目中的 README 或题目描述；
- 之前的编译错误和 Debug 记录。

### 划词解释

在编辑器中选中任意一段代码，点击选区上方的 **Explain**，ClassMate 会在对话窗口中解释这段代码的作用、关键语句和相关知识点。

### 编译、运行与错误解释

ClassMate 可以调用本机 `g++`：

- 编译当前 C++ 文件；
- 打开运行窗口供你在其中运行程序
- 高亮错误位置并解释原因。

使用方式：

1. 打开一个 C++ 文件。
2. 点击右上角 **Compile** 按钮可以编译。点击 **Open Run Panel** 按钮可以打开运行面板。在运行面板中的运行记录可以被 ClassMate 查看和智能管理，也会加入 Debug Journey 和错题本以供分析。（后半句话正在做，过两天实现）
3. 编译失败时，选中错误信息点击 **Explain**。

> 使用编译功能前，请确保已安装 `g++` 并加入系统 `PATH`。

### Debug Journey 与错题本

ClassMate 会在本地记录你的编译、求助和代码修改过程，形成一条 **Debug Journey**。你可以随时查看：

- 每次编译的成功/失败；
- 出错的文件和位置；
- 你修改了哪些代码；
- 向 ClassMate 求助的问题和回答。

点击 Debug Journey 顶部的 **Export Debug Notebook** 按钮，即可把记录整理成 Markdown 错题本，方便复习。

### 课件管理

你可以把课程 PDF/PPT 导入 ClassMate，插件会自动提取知识点并构建搜索图。之后在聊天中提问时，ClassMate 会优先参考课件内容作答。

打开方式：侧边栏 Chat 视图顶部的 **Open Courseware** 按钮，或执行 `ClassMate: Open Courseware`。

### 浏览器拓展导入题目

配合 ClassMate 浏览器拓展，你可以一键把 OJ 或课程网站的题目导入 VS Code，自动创建工作区文件和题目知识卡片。

在项目根目录下有个 `browser-extension` 文件夹，使用 Google 浏览器“插件管理”中的“加载未打包插件”功能将其加载之后，你在某个 OJ 网页上看题的时候，就可以将题目描述选中后右键，选择“导入到 ClassMate”，然后就会自动生成题目描述文档放在你的工作区中。这样操作后，ClassMate 就可以读到你的完整题面，更好帮你分析问题。

### 主题与本地设置

通过 `ClassMate: Open Settings` 打开本地设置页，可以调整：

- 对话界面颜色（用户气泡、AI 气泡、超链接等）；
- 默认对话容器（侧边栏/面板/自动）；
- 模型配置。

## 常用命令速查

| 命令 | 作用 |
|---|---|
| `ClassMate: Open Chat` | 打开侧边栏对话 |
| `ClassMate: Open Chat in Panel` | 在编辑器面板打开对话 |
| `ClassMate: Compile` | 编译当前文件 |
| `ClassMate: Compile & Run` | 编译并运行 |
| `ClassMate: Open Run Panel` | 查看运行历史 |
| `ClassMate: Explain Selected Code` | 解释选中的代码 |
| `ClassMate: Open Debug Journey` | 查看 Debug 历程 |
| `ClassMate: Export Debug Notebook` | 导出 Markdown 错题本 |
| `ClassMate: Open Courseware` | 打开课件管理 |
| `ClassMate: Open Settings` | 打开本地设置 |
| `ClassMate: Export Conversation Diagnostics` | 导出完整对话诊断（问题排查用） |

## 从源码运行

```bash
git clone https://github.com/Dualqwq/ClassMate.git
cd ClassMate/code/classmate
npm ci
npm run compile
```

在 VS Code 中打开项目，按 `F5` 启动 Extension Development Host。

常用检查命令：

```bash
npm run compile-tests
npm run lint
npm run test
npm run package
```

## 隐私与安全

- API Key 只保存在 VS Code Secret Storage，不会进入源码或项目文件。
- 模型只能读取经过验证的工作区文件；绝对路径、目录穿越、超大文件和不支持的类型会被拒绝。
- 题目知识卡片只作为提示，最终回答仍需以实际题面和代码为准。

## 导出完整对话诊断

需要对比真实插件与自动评测表现时，可执行 `ClassMate: Export Conversation Diagnostics`，或直接在聊天框输入：

```text
//export-diagnostics bug1-real.json
```

文件默认写入项目根目录的 `log/`。导出内容包括会话消息、图节点执行状态、模型调用记录、冻结工作区快照等；API key 等凭据会被剔除。

## License

当前仓库尚未指定开源许可证。在添加许可证之前，默认不授予复制、修改或分发代码的权利。
