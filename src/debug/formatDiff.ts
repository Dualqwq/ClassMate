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
