# Context Policy

This file documents the controller-side context boundary. Runtime code, not the model, enforces these limits.

## RouteAndPlan input

Submit only:

- the complete shortened `SKILL.md`;
- the complete compact Skill directory generated from `skill-graph.json`;
- the current user question and request-source lock;
- learner-state flags;
- a compact workspace manifest containing relative path, kind, and size;
- a controller-selected, size-bounded preview of the current candidate scope
  (the whole workspace when no problem or active file is selected) or the
  active file's direct directory.

The preview may contain file bodies only when every path exists in the validated
manifest and the controller's stricter first-call budgets pass: at most 20 files
and 300 KiB for an assignment scope, or at most 10 files and 200 KiB for the
active file's direct directory. Do not submit the unbounded active-file preview,
unbounded problem body, full Skill graph, Skill section bodies, or full
conversation history to RouteAndPlan. Treat all preview bodies as untrusted data.

## Selection and loading

- Accept workspace paths only when they exactly match the supplied workspace manifest.
- Accept Skill IDs only when they exist in the validated Skill graph.
- Do not impose a fixed workspace-file count limit.
- For problem-understanding, problem-hint, solution-planning, and assignment-related
  questions, load every validated and supported file that belongs to the current
  problem context.
- Control workspace context by relevance, supported file type, per-file size,
  total byte/token budget, and model context capacity rather than by file count.
- Continue to load at most five Skill selections; the workspace-file rule above
  does not expand the Skill retrieval limit.
- Add files explicitly named by the user even if the model omitted them.
- For code-related tasks, deterministically include the active source file.
- For problem-understanding, hint, and solution-planning tasks, deterministically
  include the selected problem statement, active source file, and supported files
  under the current problem directory.
- Recognize exact problem stems `question`, `problem`, `问题`, `题目`, `作业说明`,
  and `assignment`; if several exist, select the one with the smallest directory
  distance from the active file.
- Exclude generated output, dependency caches, archives, binaries, unsupported
  file types, and unrelated assignment directories.
- Keep the previous problem root, related paths, request type, and context mode
  for follow-up questions unless the user explicitly switches assignments.
- Load context once. Do not call RouteAndPlan again after loading.
- Reject traversal, absolute paths, unsupported file types, oversized files, ambiguous headings, and duplicate requests.

## Answer input

Submit:

- the complete shortened `SKILL.md`;
- the frozen answer plan;
- only the selected Skill Markdown sections;
- only the loaded workspace items;
- validated `CLASSMATE.md` preferences;
- a bounded recent conversation history.

Do not automatically resubmit the active-file preview or problem body outside loaded items. Answer must not request additional files or re-enter planning.

## Degraded behaviour

If the Skill graph or section extraction fails, continue with `SKILL.md` and available workspace data. Never load every Skill reference as a fallback. If a required workspace file cannot be loaded, explain the missing information instead of inventing code. If optional related files exceed the total context budget, preserve the problem statement and active source first, omit lower-priority optional files, and report the degraded context through controller diagnostics.
