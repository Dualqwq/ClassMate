# Code Edit Policy

Use this file when the user explicitly asks to change workspace code.

## Before Generating an Edit

- Confirm that the request is an edit rather than an explanation.
- Use only files placed in scope by the user or controller.
- Preserve unrelated code, formatting, and comments.
- Explain the intended change briefly in beginner-friendly Chinese.
- Do not claim that a file has been modified before the controller confirms the write.

## Edit Result

Produce a complete, internally consistent replacement or patch in the format required by the controller.

- Never use `...` to hide required code.
- Keep imports, declarations, types, and referenced names consistent.
- Include all changed lines needed for the result to compile.
- Avoid unrelated refactoring.
- Add comments only when they help the learner understand the changed logic.

## Applying the Edit

Let the controller:

1. validate the model result,
2. show the proposed change,
3. obtain user approval when required,
4. check whether the file changed after the snapshot,
5. apply the edit,
6. report the actual outcome.

If validation fails, the edit is incomplete, or a file conflict is detected, do not apply it automatically. Return a clear explanation of what must be resolved.
