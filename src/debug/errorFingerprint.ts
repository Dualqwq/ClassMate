import type { ParsedError } from '../error/errorParser';
import { matchErrorToKnowledge } from '../error/errorKnowledgeMap';

export interface MatchOptions {
    mode?: 'strict' | 'fuzzy' | 'knowledge';
}

export interface ErrorSignature {
    normalizedMessage: string;
    code?: string;
    knowledgeTags: string[];
    file?: string;
    /**
     * 诊断级别(error/warning;note/remark 不取)。不参与 signaturesMatch
     * 判等(生命周期匹配仍按归一化 message 跨级别判定),仅供派生层按级别
     * 折叠成卡与展示使用——同一位置的 error 与 warning 是不同的卡。
     */
    severity?: 'error' | 'warning';
}

/**
 * Normalize an error message so that the same error on different lines,
 * with different identifiers or numbers, still matches.
 */
export function normalizeErrorMessage(message: string): string {
    return message
        .toLowerCase()
        // Replace quoted identifiers/strings with a placeholder.
        .replace(/['"`][a-zA-Z_0-9\-]+['"`]/g, '<id>')
        // Replace numeric constants with a placeholder.
        .replace(/\b\d+\b/g, '<num>')
        // Collapse multiple whitespace characters.
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Create a fingerprint from a parsed compiler error.
 */
export function createErrorSignature(
    parsedError: ParsedError,
    options?: { includeFile?: boolean; includeCode?: boolean }
): ErrorSignature {
    return {
        normalizedMessage: normalizeErrorMessage(parsedError.message),
        code: options?.includeCode ? parsedError.code : undefined,
        knowledgeTags: matchErrorToKnowledge(parsedError.message).map((m) => m.tag),
        file: options?.includeFile ? parsedError.file : undefined,
        severity:
            parsedError.severity === 'error' || parsedError.severity === 'warning'
                ? parsedError.severity
                : undefined,
    };
}

/**
 * Compare two error signatures.
 *
 * - strict: normalized message and compiler code must both match.
 * - fuzzy: only normalized message must match (default).
 * - knowledge: at least one knowledge tag must overlap.
 */
export function signaturesMatch(
    a: ErrorSignature,
    b: ErrorSignature,
    options?: MatchOptions
): boolean {
    const mode = options?.mode ?? 'fuzzy';

    if (mode === 'knowledge') {
        if (a.knowledgeTags.length === 0 || b.knowledgeTags.length === 0) {
            return false;
        }
        return a.knowledgeTags.some((tag) => b.knowledgeTags.includes(tag));
    }

    if (a.normalizedMessage !== b.normalizedMessage) {
        return false;
    }

    if (mode === 'strict') {
        if (a.code || b.code) {
            return a.code === b.code;
        }
    }

    return true;
}

/**
 * Create a stable string key for an error signature.
 * Useful for grouping/counting in plain objects or Maps.
 */
export function signatureKey(signature: ErrorSignature, options?: MatchOptions): string {
    const mode = options?.mode ?? 'fuzzy';
    const parts: string[] = [signature.normalizedMessage];
    if (mode === 'strict' && signature.code) {
        parts.push(signature.code);
    }
    if (mode === 'knowledge') {
        parts.push(...signature.knowledgeTags.slice().sort());
    }
    return parts.join('|');
}
