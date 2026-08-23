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
    /**
     * Include 栈(仅由 parseCompilerStderr 的多行传播填充):该诊断所在头文件
     * 被引入的链路,从最内层到最外层,如 ["b.h:6", "a.cpp:1"]。
     * 归属文件(file)始终是诊断行自己的位置——真正报错处;本字段只描述
     * "怎么 include 到这里的"。单行 extractErrorLocation 不填。
     */
    viaIncludes?: string[];
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
 * Given a block of compiler stderr text (possibly spanning multiple lines),
 * return the first line that looks like a parseable diagnostic, or undefined
 * if none is found.
 *
 * This is useful when the user selects multiple lines of output (e.g. the
 * diagnostic line plus caret/fix-it context) but we only need the main
 * diagnostic line to extract location, severity, and message.
 */
export function extractFirstDiagnosticLine(text: string): string | undefined {
    for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) {
            continue;
        }

        // Fast heuristic: a diagnostic line contains a severity marker.
        if (/:\s*(error|warning|note|remark):\s*/.test(trimmed)) {
            return trimmed;
        }

        // Also accept "In file included from ..." context lines.
        if (/^In file included from\s+/.test(trimmed)) {
            return trimmed;
        }
    }

    return undefined;
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

/** "In file included from a.cpp:1:" 开行(多层栈的非末行以 "," 结尾)。 */
const INCLUDE_FROM_PATTERN = /^In file included from\s+(.+?):(\d+)(?::(\d+))?[,:]?\s*$/;
/** g++ 多层 include 栈的续行(缩进 + "from b.h:6,"/"from b.h:6:")。 */
const INCLUDE_CONTINUATION_PATTERN = /^\s+from\s+(.+?):(\d+)(?::(\d+))?[,:]?\s*$/;

/** 主翻译单元扩展名:这些文件的诊断不需要 include 栈,遇到即清栈。 */
function isMainTranslationUnit(file: string | undefined): boolean {
    if (!file) {
        return false;
    }
    return /\.(c|cpp|cc|cxx|C|c\+\+|m|mm)$/i.test(file);
}

function formatIncludeFrame(file: string, line: number, column?: number): string {
    return `${file}:${line}${column !== undefined ? `:${column}` : ''}`;
}

/**
 * Parse compiler stderr with include-stack propagation.
 *
 * g++ 对头文件错误先输出 include 栈再给诊断:
 *   In file included from c.h:2,
 *                    from b.h:6,
 *                    from a.cpp:1:
 *   x.h:3:10: error: ...
 * 本函数把栈快照挂到紧随其后的 error/warning 诊断上(viaIncludes,从最内层
 * 到最外层);诊断的归属 file 始终是诊断行自己的位置(真正报错处),不归给
 * 主翻译单元。MSVC 的 included-file 栈格式本项目主场景(g++/MinGW)之外,
 * 暂不支持,留后续。
 *
 * 栈生命周期:遇 "In file included from" 重置;续行追加;error/warning 诊断
 * 消费当前栈(保留给同组后续诊断);主翻译单元(.c/.cpp/…)的诊断清栈——
 * 它不属于头文件链。单条目解析语义与 parseCompilerStderr 完全一致。
 */
export function parseCompilerStderrWithIncludes(stderr: string): ParsedError[] {
    const errors: ParsedError[] = [];
    let includeStack: string[] = [];

    for (const rawLine of stderr.split('\n')) {
        const trimmed = rawLine.trim();

        const fromMatch = INCLUDE_FROM_PATTERN.exec(trimmed);
        if (fromMatch) {
            includeStack = [
                formatIncludeFrame(
                    fromMatch[1],
                    parseInt(fromMatch[2], 10),
                    fromMatch[3] ? parseInt(fromMatch[3], 10) : undefined
                ),
            ];
            // 该行本身仍按原语义产出 isIncludeContext note 条目。
            pushParsed(errors, extractErrorLocation(rawLine));
            continue;
        }

        const contMatch = INCLUDE_CONTINUATION_PATTERN.exec(rawLine);
        if (contMatch && includeStack.length > 0) {
            includeStack.push(
                formatIncludeFrame(
                    contMatch[1],
                    parseInt(contMatch[2], 10),
                    contMatch[3] ? parseInt(contMatch[3], 10) : undefined
                )
            );
            continue;
        }

        const parsed = extractErrorLocation(rawLine);
        if (!parsed) {
            continue;
        }

        if (
            (parsed.severity === 'error' || parsed.severity === 'warning') &&
            includeStack.length > 0
        ) {
            if (isMainTranslationUnit(parsed.file)) {
                // 主单元诊断不挂头文件链,并结束当前栈。
                includeStack = [];
            } else {
                parsed.viaIncludes = [...includeStack];
            }
        }
        pushParsed(errors, parsed);
    }

    return errors;
}

/** 统一入口:extractErrorLocation 成功则收下,失败忽略。 */
function pushParsed(errors: ParsedError[], parsed: ParsedError | undefined): void {
    if (parsed) {
        errors.push(parsed);
    }
}

/**
 * Plain range describing a user selection inside the compile output panel.
 * Line and character numbers are 0-based and match VS Code's Selection/Range
 * semantics. Keeping this type free of vscode imports makes the normalizer
 * easy to unit-test.
 */
export interface CompileSelectionRange {
    readonly startLine: number;
    readonly startCharacter: number;
    readonly endLine: number;
    readonly endCharacter: number;
}

/**
 * Result of normalizing a user selection from the compile output panel.
 */
export interface NormalizedCompileSelection {
    /** The main diagnostic to explain. */
    readonly primaryDiagnostic: ParsedError;
    /** Other diagnostics found inside the expanded selection, if any. */
    readonly otherDiagnostics: ParsedError[];
    /** Caret / fix-it / source-snippet lines that belong to the primary diagnostic. */
    readonly contextLines: string[];
    /** Human-readable block to show in the LLM prompt. */
    readonly displayText: string;
    /** True if the primary diagnostic was recovered by looking at full output. */
    readonly expanded: boolean;
}

const BACKWARD_SEARCH_LIMIT = 20;

function scoreDiagnosticSeverity(p: ParsedError): number {
    if (p.severity === 'error') { return 3; }
    if (p.severity === 'warning') { return 2; }
    if (p.isIncludeContext) { return 0; }
    return 1;
}

function findOwningDiagnostic(fullLines: string[], startLine: number): ParsedError | undefined {
    // Search backwards from the selection start for the nearest diagnostic line.
    // Prefer a non-include-context diagnostic, but fall back to include context.
    let fallback: ParsedError | undefined;
    const minLine = Math.max(0, startLine - BACKWARD_SEARCH_LIMIT);
    for (let i = startLine; i >= minLine; i--) {
        const parsed = extractErrorLocation(fullLines[i]);
        if (!parsed) {
            continue;
        }
        if (!parsed.isIncludeContext) {
            return parsed;
        }
        if (!fallback) {
            fallback = parsed;
        }
    }
    return fallback;
}

/**
 * Normalize an arbitrary user selection from the compile output panel into a
 * primary diagnostic plus its caret/fix-it context.
 *
 * Handles four scenarios:
 * 1. Complete multi-line block (diagnostic + caret/fix-it lines).
 * 2. Partial single-line selection -> expanded to the full line.
 * 3. Only caret/fix-it context -> primary diagnostic recovered from full output.
 * 4. Multiple incomplete diagnostics -> first diagnostic is primary, rest listed.
 *
 * @param selectedText - The exact text selected by the user.
 * @param fullOutput - The full content of the compile output panel.
 * @param range - The selection range in fullOutput line/character coordinates.
 * @returns Normalized selection, or undefined if no diagnostic could be found.
 */
export function normalizeCompileOutputSelection(
    selectedText: string,
    fullOutput: string,
    range: CompileSelectionRange | undefined
): NormalizedCompileSelection | undefined {
    if (!selectedText.trim()) {
        return undefined;
    }

    const fullLines = fullOutput.split(/\r?\n/);
    const selectedLines = selectedText.split(/\r?\n/);

    // Expand partial first/last lines to the full lines from fullOutput when we
    // have a range hint.
    let expandedLines: string[];
    if (range && fullLines.length > 0) {
        expandedLines = [...selectedLines];
        const startWithinLine = range.startCharacter;
        const startFullLine = fullLines[range.startLine] ?? '';
        const endFullLine = fullLines[range.endLine] ?? '';

        if (expandedLines.length > 0) {
            expandedLines[0] = startFullLine;
        }
        if (expandedLines.length > 1) {
            expandedLines[expandedLines.length - 1] = endFullLine;
        } else {
            // Single-line selection: expand both ends to the full line.
            expandedLines[0] = startFullLine;
        }
    } else {
        expandedLines = selectedLines;
    }

    // Parse every expanded line and collect candidates.
    const candidates: { lineIndex: number; parsed: ParsedError }[] = [];
    for (let i = 0; i < expandedLines.length; i++) {
        const parsed = extractErrorLocation(expandedLines[i]);
        if (parsed) {
            candidates.push({ lineIndex: i, parsed });
        }
    }

    let primary: ParsedError | undefined;
    let expanded = false;
    let primaryIndexInExpanded = 0;
    let prependOwningDiagnostic = false;

    if (candidates.length > 0) {
        // If the first expanded line is not a diagnostic, the user may have
        // started the selection inside a source-snippet/caret block. Try to
        // recover the owning diagnostic from just before the selection so that
        // the first error is not missed.
        const firstExpandedIsDiagnostic = extractErrorLocation(expandedLines[0]) !== undefined;
        if (!firstExpandedIsDiagnostic && range && fullLines.length > 0) {
            const owning = findOwningDiagnostic(fullLines, range.startLine);
            if (owning) {
                candidates.push({ lineIndex: -1, parsed: owning });
                prependOwningDiagnostic = true;
            }
        }

        // Prefer error > warning > note/remark > include context.
        // Within the same severity class, keep the first one in selection order.
        candidates.sort((a, b) => {
            const scoreDiff = scoreDiagnosticSeverity(b.parsed) - scoreDiagnosticSeverity(a.parsed);
            return scoreDiff !== 0 ? scoreDiff : a.lineIndex - b.lineIndex;
        });
        primary = candidates[0].parsed;
        primaryIndexInExpanded = candidates[0].lineIndex;
        if (prependOwningDiagnostic) {
            // The owning diagnostic was inserted at index -1; place it at the
            // front of expandedLines so context collection works naturally.
            expandedLines = [primary.raw, ...expandedLines];
            primaryIndexInExpanded = 0;
            expanded = true;
        }
    } else if (range && fullLines.length > 0) {
        // No parseable line inside the selection: try to recover from full output.
        const recovered = findOwningDiagnostic(fullLines, range.startLine);
        if (recovered) {
            primary = recovered;
            expanded = true;
            primaryIndexInExpanded = 0;
            // Prepend the recovered diagnostic line so context collection works.
            expandedLines = [recovered.raw, ...expandedLines];
        }
    }

    if (!primary) {
        return undefined;
    }

    // Collect context lines (caret/fix-it/source snippets) after the primary
    // diagnostic, stopping at the next parseable diagnostic.
    const contextLines: string[] = [];
    for (let i = primaryIndexInExpanded + 1; i < expandedLines.length; i++) {
        const line = expandedLines[i];
        const parsed = extractErrorLocation(line);
        if (parsed) {
            break;
        }
        if (line.trim()) {
            contextLines.push(line);
        }
    }

    const otherDiagnostics = candidates
        .filter((c) => c.parsed !== primary)
        .map((c) => c.parsed);

    // Build displayText from the expanded selection so that all diagnostics and
    // their caret/fix-it context are visible to the LLM. The primary diagnostic
    // is still identified separately for knowledge matching and location display.
    let displayText = expandedLines.join('\n');
    if (otherDiagnostics.length > 0) {
        const extras = otherDiagnostics
            .map((d) => `  - ${d.file ?? '?'}:${d.line ?? '?'}: ${d.message}`)
            .join('\n');
        displayText += `\n\nYour selection also contains these additional diagnostics:\n${extras}`;
    }
    if (expanded) {
        displayText += '\n\n(Expanded from your selection using the full compile output.)';
    }

    return {
        primaryDiagnostic: primary,
        otherDiagnostics,
        contextLines,
        displayText,
        expanded,
    };
}
