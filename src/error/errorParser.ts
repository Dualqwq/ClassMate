export interface ParsedError {
    raw: string;
    file?: string;
    line?: number;
    column?: number;
    severity?: 'error' | 'warning' | 'note';
    message: string;
}

/**
 * Parse a single line of g++/clang stderr and extract the file, line, column,
 * severity, and message.
 *
 * Supported formats:
 * - file.cpp:12:34: error: 'x' was not declared in this scope
 * - file.cpp:12: error: expected ';' before 'return'
 * - file.cpp:12:34: warning: ...
 */
export function extractErrorLocation(line: string): ParsedError | undefined {
    const trimmed = line.trim();
    if (!trimmed) {
        return undefined;
    }

    const mainPattern = /^(.+?):(\d+)(?::(\d+))?:\s*(error|warning|note):\s*(.+)$/;
    const match = mainPattern.exec(trimmed);
    if (!match) {
        return undefined;
    }

    return {
        raw: trimmed,
        file: match[1],
        line: parseInt(match[2], 10),
        column: match[3] ? parseInt(match[3], 10) : undefined,
        severity: match[4] as 'error' | 'warning' | 'note',
        message: match[5].trim(),
    };
}
