import * as Diff from 'diff';

/**
 * Normalize a block of code so it can be compared for deduplication without
 * being affected by trailing whitespace or CRLF vs LF line endings.
 *
 * Note: this is intentionally conservative. We do not collapse intra-line
 * whitespace so that two fixes with different indentation are still considered
 * distinct.
 */
export function normalizeCodeForDiff(value: string): string {
    return value.replace(/\r\n/g, '\n').replace(/\n+$/, '').trim();
}

function ensureTrailingNewline(value: string): string {
    return value.endsWith('\n') ? value : `${value}\n`;
}

/**
 * Format a fix as a simple line-level diff using the `diff` library.
 *
 * Output rules:
 * - Removed lines are prefixed with `- `.
 * - Added lines are prefixed with `+ `.
 * - Unchanged context lines are omitted by default so the result is compact.
 *
 * Example:
 * ```diff
 * - int x = 1
 * + int x = 1;
 * ```
 */
export function formatFixAsDiff(before: string, after: string): string {
    const beforeNormalized = normalizeCodeForDiff(before);
    const afterNormalized = normalizeCodeForDiff(after);

    if (beforeNormalized === afterNormalized) {
        return '(no changes)';
    }

    const changes = Diff.diffLines(
        ensureTrailingNewline(beforeNormalized),
        ensureTrailingNewline(afterNormalized),
        { newlineIsToken: false }
    );

    const lines: string[] = [];
    for (const change of changes) {
        if (!change.value) {
            continue;
        }
        const changeLines = change.value.replace(/\n$/, '').split('\n');
        for (const line of changeLines) {
            if (change.added) {
                lines.push(`+ ${line}`);
            } else if (change.removed) {
                lines.push(`- ${line}`);
            }
            // Unchanged context lines are intentionally omitted.
        }
    }

    return lines.length > 0 ? lines.join('\n') : '(no changes)';
}

interface DiffLine {
    text: string;
    type: 'unchanged' | 'added' | 'removed';
}

function buildDiffLines(before: string, after: string): DiffLine[] {
    const beforeNormalized = normalizeCodeForDiff(before);
    const afterNormalized = normalizeCodeForDiff(after);

    if (beforeNormalized === afterNormalized) {
        return [];
    }

    const changes = Diff.diffLines(
        ensureTrailingNewline(beforeNormalized),
        ensureTrailingNewline(afterNormalized),
        { newlineIsToken: false }
    );

    const result: DiffLine[] = [];
    for (const change of changes) {
        if (!change.value) {
            continue;
        }
        const changeLines = change.value.replace(/\n$/, '').split('\n');
        for (const line of changeLines) {
            if (change.added) {
                result.push({ text: line, type: 'added' });
            } else if (change.removed) {
                result.push({ text: line, type: 'removed' });
            } else {
                result.push({ text: line, type: 'unchanged' });
            }
        }
    }

    return result;
}

/**
 * Format a fix as a compact line-level diff that preserves local context.
 *
 * For each changed hunk, up to `contextLines` unchanged lines are shown before
 * and after the changed lines. This gives students the surrounding code without
 * including the entire file.
 *
 * Example:
 * ```diff
 *   int a = 1;
 * - int x = 1
 * + int x = 1;
 *   return 0;
 * ```
 */
export function formatFixWithContext(
    before: string,
    after: string,
    contextLines = 2
): string {
    const lines = buildDiffLines(before, after);
    if (lines.length === 0) {
        return '(no changes)';
    }

    const changedIndices = new Set<number>();
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].type !== 'unchanged') {
            changedIndices.add(i);
        }
    }

    const visible = new Set<number>();
    for (const index of changedIndices) {
        const start = Math.max(0, index - contextLines);
        const end = Math.min(lines.length - 1, index + contextLines);
        for (let i = start; i <= end; i++) {
            visible.add(i);
        }
    }

    const sorted = [...visible].sort((a, b) => a - b);
    const output: string[] = [];
    let previous = -2;

    for (const index of sorted) {
        if (index > previous + 1) {
            output.push('...');
        }
        const line = lines[index];
        if (line.type === 'added') {
            output.push(`+ ${line.text}`);
        } else if (line.type === 'removed') {
            output.push(`- ${line.text}`);
        } else {
            output.push(`  ${line.text}`);
        }
        previous = index;
    }

    // Trim leading "..." if we started from the first line.
    if (output[0] === '...') {
        output.shift();
    }
    // Trim trailing "..." if we ended at the last line.
    if (output[output.length - 1] === '...') {
        output.pop();
    }

    return output.length > 0 ? output.join('\n') : '(no changes)';
}

/**
 * Format a fix as a unified diff patch.
 *
 * This is useful for views that want to show a familiar patch-style output.
 */
export function formatFixAsUnifiedPatch(
    before: string,
    after: string,
    options?: { contextLines?: number; beforeLabel?: string; afterLabel?: string }
): string {
    const beforeNormalized = normalizeCodeForDiff(before);
    const afterNormalized = normalizeCodeForDiff(after);

    if (beforeNormalized === afterNormalized) {
        return '(no changes)';
    }

    const patch = Diff.createTwoFilesPatch(
        options?.beforeLabel ?? 'before',
        options?.afterLabel ?? 'after',
        ensureTrailingNewline(beforeNormalized),
        ensureTrailingNewline(afterNormalized),
        undefined,
        undefined,
        { context: options?.contextLines ?? 2 }
    );

    return patch.trimEnd();
}
