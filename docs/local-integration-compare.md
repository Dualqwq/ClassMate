# 本地集成方案对比：ADD5 设置页 token 决策 + ADD6 传输通道选型

> 决策门 G5 文档。ADD5(本地网页设置页)要不要 token、ADD6(浏览器扩展题目导入)
> 传输通道 S1–S4 选型,两项决策合并出本文档,用户审完才进波次 4 动工。
> 依据:`plan-todo-priorities-20260820.md` §二 P4 第 14/15 项、§3.1 已拍板表、§四
> 预测 6/7;`0803后要干的事情.md` ADD5/ADD6 原文。本文档不推翻任何已拍板边界,
> 只在其上做方案分析与推荐。
> 拍板状态:2026-08-21 用户已拍板,§6 D1–D6 全部按本文档建议生效(见 §6 决策记录)。

## 1. 需求与约束(已定边界)

### ADD5 本地网页设置页

- 原始诉求(ADD5 原文):把现有粗糙的 LLM Settings 界面迁移到本地网页,按设置按钮
  自动打开 `localhost:xxxx`,标签页里可放更丰富的设置(LLM Settings、主题颜色等)。
- 已拍板边界:
  - 第一期范围 = 对话框气泡颜色 + 对话框内超链接颜色,后续可加更丰富项;LLM
    Settings 迁移是原始动机,纳入同一页面。
  - 只绑 localhost(127.0.0.1)。
  - 要不要 token 由本文档定夺(§3)。
- 迁移对象现状(代码事实):
  - 现有设置 UI 是 webview 内嵌弹窗 `webview/src/components/SettingsPanel.tsx`
    (provider/model/apiKey/apiUrl + fallback 五元组,样式粗糙即 ADD5 动机);
  - 保存走 webview 消息 `saveLLMConfig`/`saveFallbackLLMConfig`
    (`src/chat/types.ts:150`),扩展主机侧 `src/config/llmConfig.ts`:
    provider/model/apiUrl 入 `globalState`,**API key 只入 `SecretStorage`**,
    下发给 UI 的配置只带 `apiKeySet` 布尔、永不下发 key 本体;
  - 本地 HTTP 基座已有先例:`src/eval/bug1ReviewServer.ts`(Node 内置 `http`,
    绑 `127.0.0.1`,JSON body 256KB 上限,CSP/no-store 响应头齐全)——ADD5/ADD6
    的 server 直接复用该模式。注意判卷 server 是 eval 工具、无 token;ADD5 是
    产品面且含凭证写路径,安全标准不同(§3),不能拿前者做"不用 token"的先例。

### ADD6 网页题目导入

- 原始诉求(ADD6 原文):让 ClassMate 把出现在网页端的题目信息自动导出为
  Markdown(运用 copy as markdown 等插件)。
- 已拍板边界:
  - 仿 copy-as-markdown 架构做 **ClassMate 浏览器扩展**(MV3,先 Chrome,
    Edge/Firefox 稍后);网页选中文字 → 转 markdown → 导入;
  - 经 VS Code `showSaveDialog` 原生弹窗让用户选保存位置,落 README.md,
    冲突按原生覆盖提示处理;
  - 传输通道 S1–S4 由本文档定夺(§4),用户委托前的倾向是 S1(与 ADD5 同基座);
  - 属仓库外新工程;copy-as-markdown LICENSE 核查归 `docs/add6-license` 子项,
    不在本文档。
- 通用架构(copy-as-markdown 类扩展,与具体实现无关):contextMenus/快捷键 →
  content script 取 `window.getSelection()` 的 HTML → Turndown 类库转 markdown →
  输出(该类扩展输出到剪贴板;ClassMate 版改为经传输通道发给 VS Code)。

## 2. 威胁模型

绑 127.0.0.1 之后,server 暴露面收缩到"本机",但本机不等于可信。资产与攻击面:

**资产**(按敏感度排序):
1. LLM API key(SecretStorage)。**间接风险**:设置端点允许改 `apiUrl`——攻击者
   不需要读 key,只要把 apiUrl 改指向自己的服务器,下一次 LLM 请求就带着
   `Authorization: Bearer <key>` 送上门。这是凭证外泄级别的危害,也是 token
   决策的核心论据。
2. provider/model/fallback 配置(被篡改 = 静默换模型/换端点,教学回答质量与
   费用受损)。
3. ADD6 导入通道(被滥用 = 骚扰弹保存对话框;因有 `showSaveDialog` 用户在场
   确认,无静默写文件路径,危害最低)。
4. 端口可用性(DoS:占用/打满连接,危害低,不展开)。

**攻击面 A:同机任意进程。** loopback 在 Windows 上对本机所有主体开放,没有
"属主进程限定"概念;任意本地进程(恶意软件、其他应用子进程、同机其他用户会话
视配置)都能 `connect(127.0.0.1:port)`。绑 127.0.0.1 对此**零防护**。

**攻击面 B:恶意网页。** 用户浏览器打开的任意网页可以尝试连本机端口:
- 简单请求(`fetch(url, {method:'POST', mode:'no-cors', contentType:'text/plain'})`)
  **不需要 CORS 预检即可送达**——SOP 只拦"读响应",拦不住"写动作"。服务端
  不回 `Access-Control-Allow-Origin` 只能让攻击者读不到结果,改设置的 POST
  已经生效。
- **Private Network Access(PNA)**:Chrome 对"公网站点 → private/local 地址
  段"的请求强制预检,要求服务端显式回 `Access-Control-Allow-Private-Network:
  true` 才放行,且对**所有 mode(含 no-cors)**生效、对"同站但更私有的地址"
  也生效(明确为防 DNS rebinding 设计)。但:强制范围随版本分阶段推进,且只
  有 Chromium 系有等价实现,Firefox/Safari 没有——**PNA 是纵深的一层,不能当
  唯一防线**。
- **DNS rebinding**:攻击者域名先解析到公网 IP 交付恶意页面,再以短 TTL 重解析
  到 127.0.0.1,浏览器视角下后续请求是"同源",CORS 与 PNA 同源检查全部失效。
  确定性防御只有服务端 **Host 头白名单**(只接受 `Host: 127.0.0.1:<port>` /
  `localhost:<port>`,其余一律 400)。
- 浏览器扩展通道(ADD6 自己):任何已安装扩展只要声明了 `127.0.0.1` 的
  host_permissions 都能连本机端口,扩展间互相不可鉴别。

**token 挡得住什么、挡不住什么:**

| 场景 | 无 token | 有 token |
| --- | --- | --- |
| 同机恶意进程改 apiUrl 窃 key | 直接得手 | 挡住(进程不知道 token) |
| 恶意网页 no-cors 写设置 | 直接得手 | 挡住 |
| 恶意网页经 DNS rebinding 读/写 | 直接得手(Host 校验可单独挡) | 挡住(Host + token 双保险) |
| 恶意浏览器扩展冒充我方扩展 | 得手 | 挡住(配对 token 只给我方扩展) |
| 能读浏览器历史/内存/命令行的本地主体拿到 token | — | **挡不住**;但该主体已能调 DPAPI 解 SecretStorage 文件,超出本威胁模型,token 不构成额外短板 |
| DoS、端口占用、重放(持有 token 时) | — | 挡不住;重放靠"重置令牌"按钮补救 |

## 3. ADD5 token 决策:**要 token**

**建议:要。** 论证:

1. **危害等级够格。** 设置端点可写 apiUrl/provider/key,无 token 时攻击面 A/B 的
   任意主体都能完成"改 apiUrl → 静默窃取后续 API key"(§2)。这不是设置被改着玩,
   是凭证失窃。
2. **绑 localhost 不构成替代。** 它对攻击面 A 零防护,对攻击面 B 要靠 PNA(分阶段、
   Chromium 限定)+ Host 校验(只挡 rebinding)两层补丁,仍剩 no-cors 直达与本地
   进程两条通路。
3. **成本极低。** `crypto.randomBytes(16)` 生成 + 一个校验中间件 + `openExternal`
   URL 带参,约几十行、零新依赖,模式与判卷 server 同构。
4. 反方观点("教学工具、本地端口、没必要")只在"端点完全只读"时成立;只要页面
   能保存设置,写端点就必须鉴别调用者。

**设计要点(随建议一并给出,细节动工时再定):**

- token 128-bit 随机 hex,存 `SecretStorage`(`classmate.localToken`),首次启动
  生成;提供"重置连接令牌"入口。**持久化而非每启动轮换**——否则 VS Code 每次
  重启后 ADD6 浏览器扩展都要重新配对,UX 不可接受;持久化的泄露面与 API key
  同级(同 SecretStorage),不降低实际水位(§2 表末两行)。
- 传递:设置按钮 → server 按需启动(或复用常驻 server)→ `env.openExternal(
  http://127.0.0.1:<port>/?t=<token>)`;页面 JS 从 query 取出后写入
  `sessionStorage` 并用 `history.replaceState` 抹掉地址栏参数,后续请求放
  `X-ClassMate-Token` 头(不进 URL、不进日志)。
- 服务端三件事:**token 校验(所有 /api 端点)+ Host 头白名单 + 永不返回任何
  CORS 响应头**(不含 `Access-Control-Allow-Origin`/`Allow-Private-Network`,
  跨源页面连预检都过不了)。
- 读端点维持现有不变式:配置下发只含 `apiKeySet` 布尔,**key 本体永不下发页面**
  (`llmConfig.ts` 现状即如此,迁移后保持)。
- ADD6 的 `/api/import-problem` 端点与设置端点**同 server、同 token**(见 §4/§5);
  浏览器扩展首次使用时手动配对一次(§6 D2)。

## 4. ADD6 传输通道 S1–S4 对比

### 各方案机制(含 API 事实)

- **S1 本地 HTTP 端点**:浏览器扩展 service worker `fetch('http://127.0.0.1:<port>/
  api/import-problem', {method:'POST', body: markdown})`;manifest 声明
  `host_permissions: ["http://127.0.0.1/*"]`(match pattern 不含端口,任意端口可连)。
  VS Code 侧与 ADD5 共用 server,加一条路由。正文大小无协议限制(自定上限即可,
  判卷 server 现例 256KB)。
- **S2 Native Messaging**:扩展 `runtime.connectNative(hostName)` ↔ 宿主进程
  stdio(JSON + 32-bit 长度前缀;宿主→扩展单条上限 1MB,扩展→宿主 64MB)。
  **关键结构问题**:Chrome 只跟注册的宿主二进制对话,而宿主进程**不是** VS Code
  扩展主机——宿主收到 markdown 后还得再找一条 IPC(本地 socket/HTTP/临时文件)
  转交 VS Code,才能弹 `showSaveDialog`。等于"S2 = 宿主进程 + 内置第二条通道",
  复杂度是叠加不是替代。分发:Windows 需写注册表(`HKCU\Software\Google\Chrome\
  NativeMessagingHosts\<name>`,HKCU 免管理员,VS Code 扩展激活时可自注册),
  但 Edge(`Software\Microsoft\Edge\...`)、Firefox(manifest schema 不同,
  `allowed_extensions` 替代 `allowed_origins`)各要一份,卸载还要清理。
- **S3 自定义 URI 协议(VS Code UriHandler)**:扩展跳
  `vscode://<publisher>.classmate/import?...`(publisher 目前未在 package.json
  设置,发布前需定)。两重首次确认:浏览器侧"Open Visual Studio Code?"
  (按站点+协议可记住)+ VS Code 侧"Allow 'ClassMate' extension to open this
  URI?"(带"Do not ask me again for this extension"勾选,按扩展记忆,可用命令
  "Manage Authorized Extension URIs"撤销)。**长度硬伤**:Windows 上 Chrome 经
  `ShellExecuteA` 调起外部协议,URL 被静默截断在约 2046–2083 字符(Chromium
  issue 实测,2025-08 仍 open;微软无正式文档);中文经 percent-encoding 膨胀
  3–9 倍,实际可带正文远小于 2KB。数 KB~数十 KB 的题目 markdown 放不下,只能
  URI 带短 id、正文走第二通道(剪贴板接力或多次分块调起),工程复杂度反超 S1。
- **S4 chrome.downloads.saveAs**:扩展 `chrome.downloads.download({url, saveAs:
  true, conflictAction:'prompt'})`,每次弹浏览器自己的保存对话框。MV3 限制:
  service worker 无 DOM、`URL.createObjectURL` 不可用,需 data: URL 或 offscreen
  document 造 blob URL。**根本问题**:文件落盘完全绕开 ClassMate——落点 ClassMate
  不知道、模板/front matter 套不上、内容校验做不了、保存对话框是浏览器的而非已
  拍板的 VS Code `showSaveDialog`。与 ADD6 拍板形态直接冲突。

### 对比表

| 维度 | S1 本地 HTTP | S2 Native Messaging | S3 UriHandler | S4 downloads.saveAs |
| --- | --- | --- | --- | --- |
| 跨浏览器性 | ✅ fetch 通用;Edge 同构,Firefox 需实测 PNA 差异 | △ 协议各家都有,但注册表/manifest schema 逐浏览器一份 | ✅ 任意浏览器跳 vscode:// 皆可 | △ Chromium 系 OK;Firefox API 兼容但行为差异 |
| 安装/分发成本 | 低:只装浏览器扩展,零宿主组件 | **高**:宿主二进制 + 注册表自注册 + 逐浏览器 manifest + 卸载清理 | 低:零组件(需定 publisher) | 最低:一个 downloads 权限 |
| 端口占用 | 有(动态端口 127.0.0.1:0 规避冲突) | 无 | 无 | 无 |
| URL 长度限制 | 无(POST body,上限自定) | 无(扩展→宿主 64MB/条) | **≈2048 字符硬顶**,中文编码膨胀后正文放不了 | 无(data:/blob URL) |
| 首次系统确认 | 无系统弹窗(扩展安装时 host_permissions 声明) | 无弹窗 | **双弹窗**:浏览器 + VS Code,各可记住 | 浏览器保存对话框每次弹(即产品形态本身) |
| 与 ADD5 同基座复用 | ✅ 同 server 加路由,token/Host 校验共用 | ❌ 零复用,还要内置第二条 IPC 转交 VS Code | ❌ 零复用 | ❌ 零复用 |
| 模板/校验能力 | ✅ ClassMate 侧全控(模板、大小/类型校验、showSaveDialog) | ✅(但链路多一跳) | ✅ VS Code 侧全控 | ❌ 绕开 ClassMate,啥也做不了 |

### 各方案结论

- **S1:推荐。** 唯一同时满足"正文无长度限制 + ClassMate 全控 + 与 ADD5 同基座"
  的方案;端口占用与安全问题由 §3 的 token+Host+无 CORS 三件套覆盖。
- **S2:淘汰。** 宿主进程不是 VS Code 扩展主机,需内置第二条 IPC,复杂度叠加;
  分发与逐浏览器注册成本高;唯一优点(无端口)不足以抵偿。
- **S3:淘汰(主通道),可留档。** ~2048 字符硬顶使其无法承载题目正文,必须再配
  第二通道,失去"简单"意义;双弹窗体验也差。若未来有"短指令调起"类需求
  (如网页一键打开某工作区)可单独再用,不进 ADD6。
- **S4:淘汰。** 与已拍板的 `showSaveDialog` 形态直接冲突,且无模板/校验/落点
  感知,退化为"普通下载器"。

## 5. 推荐方案与落地路线

**推荐:S1(本地 HTTP,与 ADD5 同基座)+ token 鉴权(§3);浏览器扩展先 Chrome,
Edge 随后,Firefox 更后。**

波次 4 落地顺序(动手前过 G5 拍板 §6):

1. **ADD5 基座先行**:`src/settings/settingsServer.ts`(新)——Node 内置 http、
   绑 `127.0.0.1:0` 动态端口、token + Host 白名单 + 无 CORS 头、静态页面内嵌;
   复用 `bug1ReviewServer.ts` 的 server 骨架与 `llmConfig.ts` 的存取函数;
   设置按钮从"开 webview 弹窗"改为"开 `http://127.0.0.1:<port>/?t=<token>`";
   GET/POST `/api/config` 保持"key 永不下发"不变式。
2. **ADD6 浏览器扩展(仓库外新工程,MV3/Chrome)**:content script 取选中 HTML
   → Turndown 类库转 markdown(附来源 URL/标题)→ POST `/api/import-problem`
   (带配对 token)→ VS Code 侧校验(大小上限、字段完整)→ `showSaveDialog`
   原生选位置 → 落 README.md,冲突走原生覆盖提示。配对:用户在 ADD5 设置页
   复制"端口 + token",粘进扩展 options 页一次。
3. **Edge**:Chromium 同构,预期仅商店分发与 host_permissions 文案差异;
   **Firefox**:MV3 差异 + 无 PNA 等价物 + `127.0.0.1` host_permissions 处理
   需实测,排最后。

评测口径:按 `ClassMate测试方法指南.md` 自建数据集——ADD5 侧覆盖 token 错/缺、
Host 头伪造、无 CORS 头断言、key 不下发断言;ADD6 侧覆盖正常导入、冲突覆盖提示、
超大正文上限、未配对拒绝。

## 6. 决策点清单(2026-08-21 已全部拍板生效)

**决策记录(2026-08-21 用户拍板):D1–D6 全部按建议通过,即时生效。** 拍板结论:D1 ADD5
要 token;D2 ADD6 端点与 ADD5 同 token + 手动配对(设置页复制"端口+token"粘进扩展一次);
D3 选 S1 本地 HTTP(S2/S4 淘汰、S3 留档不作主通道);D4 token 持久化存 SecretStorage +
提供重置按钮;D5 动态端口(127.0.0.1:0);D6 接受 token 经 URL query 传递(页面加载后即
`replaceState` 抹除 + token 可重置)。波次 4 按 §5 落地路线动工。

| # | 决策点 | 建议 |
| --- | --- | --- |
| D1 | ADD5 要不要 token | **要**(§3;写端点含 apiUrl 可窃 key,成本几十行) |
| D2 | ADD6 端点是否同要 token + 手动配对 | **要,与 ADD5 同 token**;配对=设置页复制"端口+token"粘进扩展一次。替代项:ADD6 端点免 token(最坏后果仅是骚扰弹保存对话框,用户在场),换取零配对——不推荐但可接受 |
| D3 | ADD6 传输通道选型 | **S1**;确认 S2/S4 淘汰、S3 留档不作主通道 |
| D4 | token 持久化策略 | **持久化存 SecretStorage + 提供重置按钮**(配对一次);替代项:每启动轮换(更安全但 VS Code 重启后 ADD6 需重配对) |
| D5 | 端口策略 | **动态端口(127.0.0.1:0)**,配对信息含端口;替代项:固定默认端口 + 占用回退(配对信息更稳定,但引入端口冲突面) |
| D6 | token 经 URL query 传递进浏览器历史 | **接受**:页面加载后即 `replaceState` 抹除 + token 可重置;若不接受,改"扩展激活时把 token 一次性写剪贴板"等旁路(更绕,不推荐) |

## 参考来源

- VS Code API — `window.registerUriHandler` / `env.openExternal` / `showSaveDialog`:
  <https://code.visualstudio.com/api/references/vscode-api>
- VS Code 远程开发文档(registerUriHandler 回调用法、webview 不应直连 localhost
  server 的说明):<https://code.visualstudio.com/api/advanced-topics/remote-extensions>
- VS Code 源码 `extensionUrlHandler.ts`(URI 确认弹窗文案、"Do not ask me again
  for this extension"、按扩展记忆、`extensions.confirmedUriHandlerExtensionIds`):
  <https://github.com/microsoft/vscode/blob/main/src/vs/workbench/services/extensions/browser/extensionUrlHandler.ts>
- Chrome Native Messaging(宿主 manifest、Windows 注册表位置、1MB/64MB 消息上限、
  content script 不可直连需经 service worker):
  <https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging>
- chrome.downloads API(downloads 权限、saveAs、conflictAction):
  <https://developer.chrome.com/docs/extensions/reference/api/downloads>
- MV3 service worker 限制(无 DOM/window,需 offscreen document):
  <https://developer.chrome.com/docs/extensions/develop/migrate/to-service-workers>
- Private Network Access 预检(public→local 强制预检、覆盖 no-cors、防 DNS
  rebinding 的同源预检、分阶段推进):
  <https://developer.chrome.com/blog/private-network-access-preflight>
- 自定义协议 URL 长度(Windows ShellExecute 静默截断 ~2046–2083;Chromium 自身
  上限 2MB):<https://issues.chromium.org/41322340>、
  <https://issues.chromium.org/issues/438090614>、
  <https://github.com/electron/electron/issues/40776>、
  <https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/platform_util_win.cc>
  (注:issues.chromium.org 正文需 JS 渲染,摘录经搜索索引快照核对,引用前可人工点开复核)
