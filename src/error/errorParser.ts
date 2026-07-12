export interface SourceRange {
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
}

export interface ParsedError {
    raw: string;
    file?: string;
    line?: number;
    column?: number;
    severity?: 'error' | 'warning' | 'note' | 'remark';
    message: string;
    /** Clang/GCC warning/error code, e.g. "-Wunused-variable" or "-Wundefined-identifier". */
    code?: string;
    /** True if this line is a "In file included from" context note from Clang/GCC. */
    isIncludeContext?: boolean;
    /** Optional source range for diagnostics that span multiple tokens. */
    range?: SourceRange;
}

/**
 * Detect whether a string looks like a Windows absolute path (e.g. "C:\foo").
 */
function isWindowsPathPrefix(value: string): boolean {
    return /^[a-zA-Z]:[\\\/]/.test(value);
}

function parseLocationPrefix(prefix: string): {
    file: string | undefined;
    line: number | undefined;
    column: number | undefined;
    remaining: string;
} {
    // Try Windows absolute path first: e.g. C:\dir\file.cpp:12:34
    const windowsPattern = /^([a-zA-Z]:[\\\/](?:[^\\/:]*[\\/])*[^\\/:]*?)(?::(\d+))?(?::(\d+))?$/;
    const windowsMatch = windowsPattern.exec(prefix);
    if (windowsMatch) {
        return {
            file: windowsMatch[1],
            line: windowsMatch[2] ? parseInt(windowsMatch[2], 10) : undefined,
            column: windowsMatch[3] ? parseInt(windowsMatch[3], 10) : undefined,
            remaining: '',
        };
    }

    // General Unix/relative path.
    const parts = prefix.split(':');
    return {
        file: parts[0] || undefined,
        line: parts[1] ? parseInt(parts[1], 10) : undefined,
        column: parts[2] ? parseInt(parts[2], 10) : undefined,
        remaining: parts.slice(3).join(':'),
    };
}

function parseRangeToken(token: string): SourceRange | undefined {
    // Clang source-range token: {startLine:startCol-endLine:endCol}
    // Example: {47:8-47:14}
    const match = /^\{(\d+):(\d+)-(\d+):(\d+)\}$/.exec(token);
    if (!match) {
        return undefined;
    }
    return {
        startLine: parseInt(match[1], 10),
        startColumn: parseInt(match[2], 10),
        endLine: parseInt(match[3], 10),
        endColumn: parseInt(match[4], 10),
    };
}

function chooseDiagnosticCode(codes: string[]): string {
    // Prefer specific warning/error codes like -Wunused-variable over generic
    // flags like -Werror or -Wfatal-errors.
    const genericFlags = new Set(['-Werror', '-Wfatal-errors']);
    return codes.find((c) => c.startsWith('-W') && !genericFlags.has(c))
        ?? codes.find((c) => c.startsWith('-W'))
        ?? codes[0];
}

/**
 * Parse a single line of g++/clang stderr and extract the file, line, column,
 * severity, message, and optional diagnostic code.
 *
 * Supported formats:
 * - file.cpp:12:34: error: 'x' was not declared in this scope
 * - file.cpp:12: error: expected ';' before 'return'
 * - file.cpp:12:34: warning: ...
 * - C:\path\file.cpp:12:34: error: ... (Windows absolute paths)
 * - file.cpp:12:34: note: in file included from
 * - file.cpp:12:34: error: message [-Werror,-Wundefined-identifier]
 * - file.cpp:12:34:{12:8-12:14}: error: ... (Clang source range)
 * - file.cpp(12,34): error: ... (MSVC format)
 * - file +12:34: error: ... (vi format)
 */
export function extractErrorLocation(line: string): ParsedError | undefined {
    const trimmed = line.trim();
    if (!trimmed) {
        return undefined;
    }

    // Handle "In file included from ..." notes which may not have a severity.
    const includePattern = /^In file included from\s+(.+?):(\d+)(?::(\d+))?:?$/;
    const includeMatch = includePattern.exec(trimmed);
    if (includeMatch) {
        return {
            raw: trimmed,
            file: includeMatch[1],
            line: parseInt(includeMatch[2], 10),
            column: includeMatch[3] ? parseInt(includeMatch[3], 10) : undefined,
            severity: 'note',
            message: trimmed,
            isIncludeContext: true,
        };
    }

    // MSVC format: file(line,column): severity: message
    // Also supports Windows absolute paths naturally.
    const msvcPattern = /^(.+?)\((\d+)(?:,(\d+))?\):\s*(error|warning|note|remark):\s*(.+)$/;
    const msvcMatch = msvcPattern.exec(trimmed);
    if (msvcMatch) {
        const message = msvcMatch[5];
        return {
            raw: trimmed,
            file: msvcMatch[1],
            line: parseInt(msvcMatch[2], 10),
            column: msvcMatch[3] ? parseInt(msvcMatch[3], 10) : undefined,
            severity: msvcMatch[4] as 'error' | 'warning' | 'note' | 'remark',
            message: message.trim(),
        };
    }

    // vi format: file +line:column: severity: message
    const viPattern = /^(.+?)\s+\+(\d+):(\d+):\s*(error|warning|note|remark):\s*(.+)$/;
    const viMatch = viPattern.exec(trimmed);
    if (viMatch) {
        return {
            raw: trimmed,
            file: viMatch[1],
            line: parseInt(viMatch[2], 10),
            column: parseInt(viMatch[3], 10),
            severity: viMatch[4] as 'error' | 'warning' | 'note' | 'remark',
            message: viMatch[5].trim(),
        };
    }

    // Main diagnostic line. Be careful with Windows absolute paths like C:\dir\file.cpp:12:34:.
    // We split off the severity marker first to avoid mis-parsing the drive-letter colon.
    const severityMarkerPattern = /:\s*(error|warning|note|remark):\s*/;
    const markerMatch = severityMarkerPattern.exec(trimmed);
    if (!markerMatch) {
        return undefined;
    }

    const severity = markerMatch[1] as 'error' | 'warning' | 'note' | 'remark';
    const prefix = trimmed.slice(0, markerMatch.index);
    const remainder = trimmed.slice(markerMatch.index + markerMatch[0].length);

    const { file, line: lineNumber, column, remaining } = parseLocationPrefix(prefix);

    if (!file) {
        return undefined;
    }

    // Look for source-range tokens in any trailing portion after the column.
    let range: SourceRange | undefined;
    if (remaining) {
        const rangeTokenPattern = /\{(\d+):(\d+)-(\d+):(\d+)\}/g;
        let rangeMatch: RegExpExecArray | null;
        while ((rangeMatch = rangeTokenPattern.exec(remaining)) !== null) {
            const candidate: SourceRange = {
                startLine: parseInt(rangeMatch[1], 10),
                startColumn: parseInt(rangeMatch[2], 10),
                endLine: parseInt(rangeMatch[3], 10),
                endColumn: parseInt(rangeMatch[4], 10),
            };
            if (!range) {
                range = candidate;
            }
        }
    }

    // Strip trailing diagnostic codes like [-Werror,-Wundefined-identifier] or [clang-diagnostic-error].
    const codePattern = /\s*\[([-\w]+(?:,\s*[-\w]+)*)\]\s*$/;
    const codeMatch = codePattern.exec(remainder);
    let message = remainder;
    let code: string | undefined;
    if (codeMatch) {
        message = remainder.slice(0, codeMatch.index).trim();
        const codes = codeMatch[1].split(',').map((c) => c.trim());
        code = chooseDiagnosticCode(codes);
    }

    return {
        raw: trimmed,
        file,
        line: lineNumber,
        column,
        severity,
        message: message.trim(),
        code,
        range,
    };
}

/**
 * Parse a full compiler stderr into individual diagnostic messages.
 *
 * This ignores caret/range lines and fix-it hints, returning only lines that
 * contain location and severity information.
 */
export function parseCompilerStderr(stderr: string): ParsedError[] {
    const errors: ParsedError[] = [];
    for (const rawLine of stderr.split('\n')) {
        const parsed = extractErrorLocation(rawLine);
        if (parsed) {
            errors.push(parsed);
        }
    }
    return errors;
}
