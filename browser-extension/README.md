# ClassMate 浏览器扩展（题目导入）

Chrome Manifest V3 扩展，允许用户在浏览网页时选中题目正文，一键以 Markdown 形式导入到本地 VS Code 的 ClassMate 扩展。

## 安装

1. 打开 Chrome 扩展管理页：`chrome://extensions/`。
2. 开启右上角「开发者模式」。
3. 点击「加载已解压的扩展程序」。
4. 选择本仓库的 `browser-extension/` 目录（即 `<classmate 仓库根>/browser-extension/`）。

## 使用

1. 确保 VS Code 已启动 ClassMate：**底部状态栏应显示「ClassMate 导入:端口」**（扩展已随 VS Code 启动自动激活）。若状态栏没有该项，说明导入服务未启动——查看 VS Code「输出」面板 → 通道「ClassMate Browser Import」，并确认使用的是最新构建。
2. 在题目网页选中正文。
3. 点击浏览器工具栏的 ClassMate 图标，确认预览内容后点击「导入到 VS Code」。
4. Popup 内会逐端口显示探测进度（如 `53135 连接被拒 / 53136 连接被拒 / 53137 ✓ 已连接`），命中后自动发送；VS Code 弹出原生保存对话框，选择保存 `README.md` 的位置即可。**若未见弹窗，请点击任务栏 VS Code 图标——原生对话框可能落在后台窗口。**

也可在选区上右键 →「以 Markdown 导入到 ClassMate」（此路径无进度显示，失败时工具栏图标出现红色感叹号）。

## 配置

无需手动配置：VS Code 端默认会在 `53135–53145` 中绑定一个空闲端口，扩展按同一区间自动探测。仅当该区间被其他程序全部占满（VS Code 端 OutputChannel 会出现告警、状态栏显示离线）时，才需要在 VS Code 设置 `classmate.browserExtension.importPort` 指定固定端口，并在浏览器扩展中同步（`chrome.storage.local` 键 `classmateImportPort`）。

## 日志与排障

导入链路为「网页选区 → content script → service worker → 本地 HTTP 端点 → VS Code 原生保存弹窗」，任一段断链都可按下面的日志定位：

- **Popup 内诊断（对用户可见，无需开发者工具）**：点导入后状态区逐端口显示探测进度与结果；全败时给出原因分类与自查指引。
- 浏览器侧控制台（均带前缀）：
  - `[ClassMate popup]`：popup 右键 →「检查」打开的控制台；
  - `[ClassMate import]`：`chrome://extensions/` → 本扩展「详情」→「Service Worker」链接打开的控制台（逐端口探测含 health 响应体、POST 状态码与响应体都在这里）；
  - `[ClassMate content]`：网页本身 F12 控制台。
- VS Code 侧：
  - **状态栏**：「ClassMate 导入:<端口>」= 服务在监听；「ClassMate 导入离线」= 启动失败；
  - Output 面板选择通道 **ClassMate Browser Import**：服务绑定端口与策略、每个请求的方法+路径+来源、校验拒绝、`showSaveDialog` 调用与返回值、写盘路径。

## 技术说明

- 本地端点仅监听 `127.0.0.1`，拒绝外部请求。
- Markdown 转换采用轻量自研实现，参考 [yorkxin/copy-as-markdown](https://github.com/yorkxin/copy-as-markdown)（MIT License）的架构思路。
