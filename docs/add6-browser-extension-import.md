# ADD6 浏览器扩展题目导入

> 状态：已实现（Chrome MV3），待 G5 人工审核。

## 1. 设计目标

让用户在浏览题目网页时，选中正文即可一键以 Markdown 形式导入到本地 VS Code ClassMate 扩展，弹出原生保存对话框选择 `README.md` 落点。

## 2. 方案拍板（2026-08-22）

- **传输通道**：本地 HTTP 端点，与 ADD5 同基座思路（127.0.0.1 仅本地回环）。
- **浏览器**：先跑通 Chrome Manifest V3。
- **落点**：VS Code `showSaveDialog` 原生弹窗，默认文件名 `README.md`，冲突由 VS Code 原生覆盖提示处理。
- **工程位置**：本仓库 monorepo 目录 `code/classmate-browser-ext/`。
- **Markdown 转换**：走 yorkxin/copy-as-markdown（MIT）轻量自研思路，不引入 Turndown/Readability npm 依赖。

## 3. VS Code 端实现

### 3.1 本地 HTTP 服务

- 模块：`src/browserExtensionImport/server.ts`
- 仅监听 `127.0.0.1`，拒绝外部 IP。
- 端口可配置：`classmate.browserExtension.importPort`。显式配置 > 0 直接绑定；默认（0）在浏览器扩展探测区间 `53135–53145` 内依次绑定第一个空闲端口，区间全部被占才回退随机端口并记录告警。（G5 复审修复：原先默认绑 OS 随机端口，浏览器扩展只探测固定区间，端点永远发现不了，保存弹窗不会出现。）
- 启动后端口写入 `context.globalState`（`classmate.browserExtension.importPort`）；浏览器扩展对 `53135–53145` 逐一 `GET /health` 探测发现实际端口。
- 关键节点日志输出到 OutputChannel `ClassMate Browser Import`（`src/browserExtensionImport/log.ts`）：服务启动与绑定策略、每个请求、校验拒绝、`showSaveDialog` 调用与结果、写文件成败。
- 路由：
  - `GET /health`：返回 `{ ok: true, port: number }`。
  - `POST /import`：接收 `{ title?, markdown, url? }`，调用保存流程。
  - `OPTIONS`：处理 CORS 预检。

### 3.2 保存流程

- 模块：`src/browserExtensionImport/importHandler.ts`
- 校验 markdown 非空。
- 若提供 title/url，注入 YAML frontmatter。
- 调用 `vscode.window.showSaveDialog`，默认落点为工作区根 `README.md`。
- 用户确认后写入 `vscode.workspace.fs.writeFile`；保存后尝试打开文件。
- 依赖可注入，便于单元测试 mock。

### 3.3 集成点

- `extension.ts` activate 时启动服务器，dispose 时关闭。
- **激活时机**：`package.json` activationEvents 含 `onStartupFinished`（G5 二轮修复：原先只有 onLanguage/onView/onCommand 触发器，用户装好后若没打开过 C/C++ 文件或面板，activate 不执行、server 根本不存在，浏览器侧导入永远失败）。
- **状态栏自检**（纯代码，零 manifest 改动）：server 监听中显示 `$(plug) ClassMate 导入:<端口>`，启动失败显示 `$(error) ClassMate 导入离线`；点击执行 `classmate.showBrowserExtensionImportStatus`。
- 新增命令 `classmate.showBrowserExtensionImportStatus`，显示当前监听端口。
- `package.json` 注册命令与配置项。

## 4. 浏览器扩展实现

目录：`code/classmate-browser-ext/`

| 文件 | 说明 |
|---|---|
| `manifest.json` | MV3，权限 `activeTab/scripting/contextMenus/storage`，匹配 `<all_urls>`。 |
| `content.js` | 内容脚本：读取选区或页面正文，转换为轻量 Markdown；监听 `classmate-collect` 消息。 |
| `background.js` | Service Worker：右键菜单、端口探测、POST 到本地端点、消息转发。 |
| `popup.html/js/css` | 预览/编辑标题与 Markdown、触发导入。 |
| `README.md` | 安装使用说明。 |
| `THIRD-PARTY-NOTICES.md` | yorkxin/copy-as-markdown MIT 声明。 |

### 4.1 转换规则

段落、标题 `h1-h6`、粗体/斜体、链接、图片、代码、代码块、列表、引用、分隔线。不做复杂表格/MathML，满足常见 OJ/博客题目导入即可。

### 4.2 安全

- 只向 `127.0.0.1` 发送请求。
- 不收集 cookies 或用户身份。
- 选区优先，避免上传整页无关内容。

## 5. LICENSE 合规

- 参考项目 yorkxin/copy-as-markdown 为 MIT License。
- 本扩展自研实现，架构思路参考；未逐行复制实质代码。
- 仍按拍板要求，在 `code/classmate-browser-ext/THIRD-PARTY-NOTICES.md` 中保留其版权声明与 MIT 许可摘录。
- 不引入 Turndown/Readability 等第三方 npm 依赖，无额外 license 义务。

## 6. 测试

- 单测：`src/test/browserExtensionImport.test.ts`
  - `buildMarkdownBody` 各种 frontmatter 场景。
  - `handleBrowserExtensionImport` 的 mock 保存/取消路径。
  - 本地 HTTP 服务器健康检查端点。
- 运行命令：`npm run test`。

## 7. 待 G5 人审验证项

1. Chrome 扩展加载后，在题目网页选中正文 → popup 显示选区预览。
2. 点击「导入到 VS Code」→ VS Code 弹出原生保存对话框。
3. 选择工作区子目录保存 `README.md` → 文件内容含 frontmatter 与 Markdown 正文。
4. LICENSE 引用合规（本文件 §5 + `THIRD-PARTY-NOTICES.md`）。
