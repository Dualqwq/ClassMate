import type { DebugEventIndex } from '../debug/debugJourneyStore';
import type { DebugEvent } from '../debug/types';

const MAX_SHOWN_DIAGNOSTICS = 8;

/**
 * Format a list of DebugEvents into the human-readable summary shown by the
 * //show-log command.
 */
export function formatDebugLog(events: DebugEvent[], index: DebugEventIndex, workspaceId: string): string {
    const lines: string[] = [
        '=== DEBUG: implicit log ===',
        `workspaceId: ${workspaceId}`,
        `total events: ${index.total}`,
        `counts: ${JSON.stringify(index.counts, null, 2)}`,
        '',
        `recent ${events.length} event(s):`,
        '',
    ];

    for (const event of events) {
        lines.push(`- [${new Date(event.timestamp).toISOString()}] ${event.type} (${event.id})`);

        if (event.type === 'compile_error') {
            const parsed = event.parsedErrors ?? [];
            if (parsed.length > 0) {
                const errorCount = parsed.filter((p) => p.severity === 'error').length;
                const warningCount = parsed.filter((p) => p.severity === 'warning').length;
                const noteCount = parsed.filter(
                    (p) => p.severity === 'note' || p.severity === 'remark'
                ).length;
                lines.push(
                    `  diagnostics: ${parsed.length} total (${errorCount} error(s), ${warningCount} warning(s), ${noteCount} note(s))`
                );

                for (let i = 0; i < Math.min(parsed.length, MAX_SHOWN_DIAGNOSTICS); i++) {
                    const p = parsed[i];
                    const location = `${p.file ?? '?'}:${p.line ?? '?'}:${p.column ?? '?'}`;
                    lines.push(`    [${p.severity ?? 'error'}] ${location}: ${p.message}`);
                }
                if (parsed.length > MAX_SHOWN_DIAGNOSTICS) {
                    lines.push(`    ... and ${parsed.length - MAX_SHOWN_DIAGNOSTICS} more diagnostic(s)`);
                }
            } else if (typeof event.stderr === 'string' && event.stderr) {
                lines.push(`  stderr preview: ${event.stderr.split('\n')[0].slice(0, 120)}`);
            }
        } else if ('stderr' in event && typeof event.stderr === 'string') {
            lines.push(`  stderr preview: ${event.stderr.split('\n')[0].slice(0, 120)}`);
        }

        if ('stdout' in event && typeof event.stdout === 'string' && event.stdout) {
            lines.push(`  stdout preview: ${event.stdout.split('\n')[0].slice(0, 120)}`);
        }
        if ('intent' in event) {
            lines.push(`  intent: ${event.intent}`);
        }
        if ('diff' in event && typeof event.diff === 'string') {
            lines.push(`  diff preview: ${event.diff.split('\n').slice(0, 3).join(' | ').slice(0, 120)}`);
        }
        if ('before' in event && 'after' in event) {
            const beforeLines = typeof event.before === 'string' ? event.before.split('\n').length : 0;
            const afterLines = typeof event.after === 'string' ? event.after.split('\n').length : 0;
            lines.push(`  lines: ${beforeLines} -> ${afterLines}`);
        }
    }

    return lines.join('\n');
}

/**
 * Format a list of DebugEvents into the raw JSON dump shown by the
 * //show-raw-log command.
 */
export function formatRawDebugLog(events: DebugEvent[], index: DebugEventIndex, workspaceId: string): string {
    return [
        '=== DEBUG: raw implicit log ===',
        `workspaceId: ${workspaceId}`,
        `total events: ${index.total}`,
        `counts: ${JSON.stringify(index.counts, null, 2)}`,
        '',
        'Events (JSON, one per line):',
        '',
        ...events.map((event) => JSON.stringify(event)),
    ].join('\n');
}
