import { parseCompilerStderrFull } from '../error/templateBacktrace';
import type { BaseDebugEvent, CompileErrorEvent, CompileSuccessEvent } from './types';

/** All build entry points record diagnostic evidence even when the exit code is zero. */
export function createCompileOutcome(
    context: Omit<BaseDebugEvent, 'type'>,
    result: { exitCode: number | null; stderr: string; durationMs: number },
    workspaceRoot?: string,
    diagnosticsComplete = true
): CompileErrorEvent | CompileSuccessEvent {
    return {
        ...context,
        type: result.exitCode === 0 ? 'compile_success' : 'compile_error',
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        ...(result.exitCode === 0 ? { diagnosticsComplete } : {}),
        stderr: result.stderr,
        // [] means no diagnostics emitted; only complete observations prove absence.
        parsedErrors: parseCompilerStderrFull(result.stderr, { workspaceRoot }),
    };
}
