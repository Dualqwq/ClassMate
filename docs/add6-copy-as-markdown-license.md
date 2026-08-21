# ADD6 前置核查:copy-as-markdown 扩展源码与 LICENSE 调查报告

- 检索日期:2026-08-21
- 目的:ADD6(网页题目导入浏览器扩展)动手前,确认 Chrome 商店 copy-as-markdown 扩展的源码可参
  考到什么程度(架构参考 / 代码复制),以及对 ClassMate(VSIX 可能闭源分发 + 独立浏览器扩展工
  程)的义务影响。
- 结论速览:**首选扩展 yorkxin/copy-as-markdown 为 MIT License,可自由阅读架构、可复制代码
  (需保留版权声明),不传染闭源;两个备选源(notlmn MIT、markdownload Apache-2.0)同样可用。**

## 1. 首选扩展甄别:同名扩展众多,用户最多的是 yorkxin 版

Chrome Web Store 上名为 "Copy as Markdown" 的扩展有 10 个以上。逐一核对商店页后,用户最可能
指的是这一个(用户量最高、搜索排名最高、长期维护):

| 项目 | 内容 |
|---|---|
| 商店名称 | Copy as Markdown |
| 发布者 | yorkxin(原 GitHub 账号 chitsaou,已改名,旧仓库地址 301 跳转到新地址,同一作者同一项目) |
| 商店链接 | <https://chromewebstore.google.com/detail/copy-as-markdown/fkeaekngjflipcockcnpobkpbbfbhmdn> |
| 用户量 / 评分 | 30,000 用户(商店页 HTML 实测);评分 4.3 |
| 版本 | 商店 v3.7.0(2026-06-02 更新);仓库 `firefox-mv3/manifest.json` 为 v3.6.0,Manifest V3 |
| 源码仓库 | <https://github.com/yorkxin/copy-as-markdown>(751 stars,最近 push 2026-08-12,活跃维护,未归档;商店页 releases 链接直达此仓库) |

同名竞品(供对照,均未超过首选):notlmn 版 10,000 用户(见 §3.1);其余同名 listing 用户量
均在 200 以下(Laxman 之外的 VTRN Development、gearwhiz、Crystaria、Bruno Volpato、Lt.Sulla
等发布者,逐一核对过商店页)。GitHub 另有 zcag/copy-as-markdown(1 star,2026-03 新建),可忽
略。

### 1.1 License 核实:MIT

- 仓库根目录 License 文件:`MIT-LICENSE.txt`(GitHub API 识别为 `MIT | MIT License`)
- 原文:<https://raw.githubusercontent.com/yorkxin/copy-as-markdown/master/MIT-LICENSE.txt>
- 关键句引用:

  > Copyright (c) 2012-2024 Yu-Cheng Chuang
  >
  > Permission is hereby granted, free of charge, to any person obtaining a copy of this
  > software and associated documentation files (the "Software"), to deal in the Software
  > **without restriction**, including without limitation the rights to **use, copy, modify,
  > merge, publish, distribute, sublicense, and/or sell** copies of the Software ...
  >
  > The above copyright notice and this permission notice shall be included in all copies or
  > **substantial portions** of the Software.

- 条款解读:使用/复制/修改/再分发/再授权/商用全部允许(含闭源分发);**唯一义务**是在所有
  副本或"实质部分"(substantial portions)中保留上述版权声明 + 许可声明。无 copyleft、无专
  利条款、无 NOTICE 要求。

### 1.2 架构参考价值(顺带记录,供 ADD6 设计用)

- 纯 MV3 扩展,工程结构:`chrome/manifest.json` + `firefox-mv3/`(Firefox MV3 移植),源码为
  原生 JS(`jsconfig.json`),Playwright e2e;根 `package.json` 运行时依赖仅 `mustache`
  (模板)。功能面:选区/链接/图片转 Markdown、整窗标签页导出为链接列表/任务列表、按标签分组。
- 即:它的 HTML→Markdown 转换是自研轻量实现而非依赖 Turndown,代码量小、适合通读。

## 2. License 结论:能参考到什么程度

1. **阅读参考架构:完全可以,无任何限制。** 思想、架构、流程不受版权保护;且三个候选仓库均公
   开源码,阅读行为本身无任何义务。
2. **复制代码片段:可以。** 首选(yorkxin)与备选一(notlmn)均为 MIT——允许复制/修改/再授
   权/闭源商用,**义务仅为在复制的实质部分保留其版权声明与 MIT 许可声明**(实践中:源文件头
   部注释或 THIRD-PARTY-NOTICES 文件)。备选二(markdownload)为 Apache-2.0——同样允许闭源
   商用,义务为保留版权/许可声明、标注修改处;附带专利授权条款(对衍生作品更有利);该仓库
   **无 NOTICE 文件**(已核实根目录),故无额外 NOTICE 义务。
3. **对 ClassMate 的影响:均不构成障碍。** MIT 与 Apache-2.0 都不带 copyleft,VSIX 闭源分发、
   浏览器扩展工程放在仓库外/闭源均合法。唯一要养成的习惯:凡逐行搬用"实质部分"代码,带上对
   方 copyright notice;只借鉴思路自写代码则连这一点都不需要。
4. **另一条路(供拍板):** 这类扩展的 HTML→Markdown 核心通常由库承担——markdownload 依赖
   Readability.js(Apache-2.0,Mozilla)+ Turndown(MIT)。ClassMate 若直接以 npm 依赖引入
   Turndown/Readability 而非参考扩展源码,义务同样是保留声明,且获得持续维护。ADD6 设计时可
   在"参考 yorkxin 自研实现"与"直接依赖 Turndown"之间选型。

## 3. 备选参考源(首选已够用,此处存档)

### 3.1 notlmn/copy-as-markdown — MIT

- 商店:"Copy as Markdown",发布者 Laxman,10,000 用户,评分 3.8,v25.6.9(2025-06-11 更新)
  <https://chromewebstore.google.com/detail/copy-as-markdown/nlaionblcaejecbkcillglodmmfhjhfi>
- 仓库:<https://github.com/notlmn/copy-as-markdown>(380 stars,最近 push 2025-06-09)
- License 文件:`license`,MIT,原文
  <https://raw.githubusercontent.com/notlmn/copy-as-markdown/master/license>,关键句:
  > Copyright (c) Laxman Damera <notlmn@outlook.com> (notlmn.github.io)
  > Permission is hereby granted, free of charge, ... to deal in the Software without
  > restriction ... The above copyright notice and this permission notice shall be included
  > in all copies or substantial portions of the Software.
- 特点:选区转 Markdown 支持 GFM 表格/任务列表、代码块语言识别、MathML→LaTeX;仅
  `contextMenus` + `activeTab` 两权限,最小权限设计值得 ADD6 借鉴。

### 3.2 deathau/markdownload(MarkDownload - Markdown Web Clipper)— Apache-2.0

- 商店:30,000 用户,4.7★(156 评分),v3.4.0(2024-08-23 更新),发布者 death.au
  <https://chromewebstore.google.com/detail/markdownload-markdown-web/pcmpcfapbekmbjjkdalcgopdkipoggdi>
- 仓库:<https://github.com/deathau/markdownload>(4,001 stars,未归档;注意用户名是
  `deathau` 不是 `death_au`)
- License 文件:`LICENSE`,Apache License 2.0(GitHub API 识别 `Apache-2.0`),原文
  <https://raw.githubusercontent.com/deathau/markdownload/main/LICENSE>,关键句(§2 版权授权):
  > each Contributor hereby grants to You a perpetual, worldwide, non-exclusive, no-charge,
  > royalty-free, irrevocable copyright license to reproduce, prepare Derivative Works of,
  > publicly display, publicly perform, sublicense, and distribute the Work and such
  > Derivative Works in Source or Object form.

  §3 另有对等专利授权;仓库根目录**无 NOTICE 文件**(已核实),无 NOTICE 保留义务。
- 特点:整页剪辑为 .md(Readability 正文抽取 + Turndown 转换),与 ADD6"网页题目导入"场景
  最接近;其 Obsidian 集成的弹窗预览/编辑流程也可作交互参考。
- 注意:商店存在同名仿冒 listing("MarkDownload" pklblaefkkcmofjcobdmcflmdphecpne、"Modern
  MarkDownload" lfihmpgmbpingelkgmodjgghdcjeiikk,均为不同发布者),参考时认准 death.au。

## 4. 未核实事项

- 各扩展**商店页"隐私权政策"链接内容**未逐条核查(与代码 License 无关,仅当 ADD6 要上架商店
  时才需要单独处理隐私政策合规)。
- yorkxin 仓库 `chrome/manifest.json` 具体版本号未读取(读的是 `firefox-mv3/manifest.json`
  v3.6.0);不影响 License 结论。
- "Slurp" 扩展未调查(同类备选已足够)。

## 5. 需用户拍板项(G5 人审输入)

1. **ADD6 技术选型**:参考 yorkxin 自研轻量转换(通读其源码、自行实现),还是直接 npm 依赖
   Turndown + Readability(与 markdownload 同路线)?两者 License 义务相同(保留声明),差别在
   包体积与维护成本。
2. **署名实践**:是否在 ClassMate 仓库引入 `THIRD-PARTY-NOTICES.md` 统一记录第三方代码/库声
   明(只要复制实质代码或打包依赖,就需要)?
3. **浏览器扩展工程的开源策略**:放本仓库 monorepo 还是独立仓库、是否开源——License 层面两
   者均可,属项目策略问题。
