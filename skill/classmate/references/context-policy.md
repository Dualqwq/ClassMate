# Context Policy

This file documents the controller-side context boundary. Runtime code, not the model, enforces these limits.

## RouteAndPlan input

Submit only:

- the complete shortened `SKILL.md`;
- the complete compact Skill directory generated from `skill-graph.json`;
- the current user question and request-source lock;
- learner-state flags;
- a compact workspace manifest containing relative path, kind, and size.

Do not submit workspace file bodies, active-file previews, `question.md` content, the full Skill graph, Skill section bodies, or full conversation history to RouteAndPlan.

## Selection and loading

- Accept workspace paths only when they exactly match the supplied workspace manifest.
- Accept Skill IDs only when they exist in the validated Skill graph.
- Load at most five workspace requests and five Skill selections.
- Add files explicitly named by the user even if the model omitted them.
- For code-related tasks, deterministically include the active source file.
- For problem-understanding and hint tasks, deterministically include the selected problem statement.
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

If the Skill graph or section extraction fails, continue with `SKILL.md` and available workspace data. Never load every Skill reference as a fallback. If a required workspace file cannot be loaded, explain the missing information instead of inventing code.
