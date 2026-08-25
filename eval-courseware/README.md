# eval-courseware — 课件检索质量评测题目集

用途：**期 3 度量闭环**的人工判卷基线数据。期 2（检索质量+注入形态）合入后，
用本题目集对「改造前 vs 改造后」做 recall@4 人工对比判卷（设计文档
`plan-courseware-utilization-20260822.md` §二 验收口径）。

- 题目集版本：`questions-recall20-v1.md`（v1，2026-08-24，配合期 2 分支准备）
- 课件语料：仓库外 `智理杯/test_courseware/` 下 5 份真实课件
  （Class02/Class04 循环、Class06 树、Class08 第八章、Class09 group 应用）
- 判卷口径：每题取检索 top-4 片段，人工标注是否包含能回答该题的片段；
  指标 = recall@4，同时记录败因分类（词面缺失/同义改述/表外中英/排序被挤/其他），
  分类口径见 plan §二度量层。
- 负例说明：Q16–Q20 为课件外负例，正确行为是检索返回空或明显无关（不注入），
  注入即记一次事实冲突风险。
- 运行方式：在扩展宿主内逐题调用 `coursewareService.retrieveFormatted(query)`
  （与 answer 链路同一入口），把输出粘贴进判卷表格即可；不需要跑通自动化判卷。

期 3 正式立项时（`feat/courseware-eval-loop`）再决定是否脚本化；本目录当前只承载
人工对照用的静态题目清单。
