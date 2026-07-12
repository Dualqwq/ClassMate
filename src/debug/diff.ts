/**
 * Simple line-level diff.
 *
 * Returns a unified-style text where:
 * - lines only in `before` are prefixed with `- `
 * - lines only in `after` are prefixed with `+ `
 *
 * This is intentionally primitive to avoid adding a dependency in the MVP.
 */
export function computeLineDiff(before: string, after: string): string {
    const beforeLines = before === '' ? [] : before.split('\n');
    const afterLines = after === '' ? [] : after.split('\n');

    const removed = beforeLines.filter((line) => !afterLines.includes(line));
    const added = afterLines.filter((line) => !beforeLines.includes(line));

    const parts: string[] = [];
    for (const line of removed) {
        parts.push(`- ${line}`);
    }
    for (const line of added) {
        parts.push(`+ ${line}`);
    }

    return parts.join('\n');
}
