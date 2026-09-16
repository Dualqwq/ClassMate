import { extractErrorLocation, type ParsedError } from './errorParser';
import type { CompileErrorEvent } from '../debug/types';

/** Read-only display evidence; raw persisted diagnostics and event fingerprints stay untouched. */
export interface DiagnosticDetail {
    label: string;
    message: string;
    raw: string;
    file?: string;
    line?: number;
    column?: number;
}

export interface LogicalDiagnostic extends ParsedError {
    /** Student-facing explanation, separate from the original message used by signatures. */
    explanation?: string;
    diagnosticDetails?: DiagnosticDetail[];
}

function detail(parsed: ParsedError, label: string): DiagnosticDetail {
    return { label, message: parsed.message, raw: parsed.raw,
        file: parsed.file, line: parsed.line, column: parsed.column };
}

export function diagnosticText(parsed: LogicalDiagnostic): string {
    return parsed.explanation ?? parsed.message;
}

/** Normalize old parameterized codes in memory without discarding include/template metadata. */
function normalizeLegacyCode(parsed: ParsedError): ParsedError {
    if (parsed.code || !/\[-W[\w-]+=[\w-]*\]\s*$/.test(parsed.message)) {
        return parsed;
    }
    const reparsed = extractErrorLocation(parsed.raw);
    return reparsed?.code ? { ...parsed, code: reparsed.code, message: reparsed.message } : parsed;
}

function warningFamily(parsed: ParsedError): string | undefined {
    return parsed.severity === 'warning' ? parsed.code?.split('=')[0] : undefined;
}

/**
 * Derive logical diagnostics for both new and already persisted events. Only complete,
 * evidenced GCC groups are collapsed. Unknown/incomplete diagnostics remain unchanged.
 * This function never mutates the event, parsedErrors, fingerprint, or raw stderr.
 */
export function logicalDiagnostics(
    event: Pick<CompileErrorEvent, 'parsedErrors' | 'stderr'>
): LogicalDiagnostic[] {
    const parsed = event.parsedErrors.map(normalizeLegacyCode);
    const lines = (event.stderr ?? '').split(/\r?\n/);
    // Sequential matching keeps repeated identical diagnostics in separate output regions.
    let cursor = 0;
    const positions = parsed.map(p => {
        const at = lines.findIndex((line, index) => index >= cursor && line.trim() === p.raw.trim());
        if (at >= 0) { cursor = at + 1; }
        return at;
    });
    const separatedOnlyByContext = (from: number, to: number, allowIncludes = false): boolean => {
        const start = positions[from];
        const end = positions[to];
        if (start < 0 || end <= start) { return false; }
        return lines.slice(start + 1, end).every(line =>
            /^\s*$|^\s*(?:\d+\s*)?\|/.test(line) ||
            (allowIncludes && /^(?:In file included from\s|\s+from\s)/.test(line))
        );
    };
    const result: LogicalDiagnostic[] = [];
    for (let index = 0; index < parsed.length; index++) {
        const current = parsed[index];
        const next = parsed[index + 1];
        const last = parsed[index + 2];
        const after = /^'([^']+)' will be initialized after$/.exec(current.message);
        const before = next && /^'([^']+)'$/.exec(next.message);
        if (warningFamily(current) === '-Wreorder' && after && before && last &&
            warningFamily(next) === '-Wreorder' && warningFamily(last) === '-Wreorder' &&
            last.message === 'when initialized here' && current.file !== undefined &&
            next.file === current.file && last.file === current.file &&
            current.line !== undefined && next.line !== undefined && last.line !== undefined &&
            separatedOnlyByContext(index, index + 1) && separatedOnlyByContext(index + 1, index + 2)) {
            result.push({ ...current,
                explanation: `成员初始化顺序与声明顺序不一致：初始化列表把 ${after[1]} 写在前面，但 ${before[1]} 会先初始化。`,
                diagnosticDetails: [detail(current, '初始化列表中写在前面的成员'),
                    detail(next, '实际先初始化的成员'), detail(last, '构造函数位置')],
            });
            index += 2;
            continue;
        }
        const hidden = /^'([^']+)' was hidden$/.exec(current.message);
        if (warningFamily(current) === '-Woverloaded-virtual' && hidden) {
            let relatedIndex = index + 1;
            while (parsed[relatedIndex]?.isIncludeContext) { relatedIndex++; }
            const related = parsed[relatedIndex];
            const by = related?.severity === 'note' && /^by '([^']+)'$/.exec(related.message);
            // The real GCC output inserts an include header between the warning and note.
            // Do not cross a new translation unit or arbitrary unparsed compiler output.
            const outerFile = current.viaIncludes?.at(-1)?.replace(/:\d+(?::\d+)?$/, '');
            const compatibleIncludes = parsed.slice(index + 1, relatedIndex).every(p =>
                p.isIncludeContext && outerFile !== undefined && p.file === outerFile
            );
            if (by && compatibleIncludes && separatedOnlyByContext(index, relatedIndex, true)) {
                result.push({ ...current,
                    explanation: `虚函数 ${hidden[1]} 被同名成员 ${by[1]} 隐藏；请检查参数与 const 修饰是否一致。`,
                    diagnosticDetails: [detail(current, '被隐藏的虚函数'), detail(related, '同名成员函数')],
                });
                // Include context entries remain available; only the related note is attached.
                result.push(...parsed.slice(index + 1, relatedIndex));
                index = relatedIndex;
                continue;
            }
        }
        result.push(current);
    }
    return result;
}
