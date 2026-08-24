import type { RunErrorKind } from './runErrorKind';

/**
 * Run 错误分类器(#12b/#14b)。
 *
 * 纯函数：输入运行结果，输出 { kind, confidence }。
 * 同时覆盖 Windows MinGW 与 Linux/macOS 的常见 stderr 模式；
 * 无法明确分类的 SIGSEGV 退到 runtime_segmentation_fault，
 * 完全无法识别退到 runtime_unknown。
 */

export interface RunErrorClassifierInput {
    exitCode: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    needsInteractiveInput: boolean;
}

export type ClassificationConfidence = 'high' | 'medium' | 'low';

export interface RunErrorClassification {
    kind: RunErrorKind;
    confidence: ClassificationConfidence;
}

/** 数组越界 / 缓冲区溢出相关模式（Windows MinGW + Linux/macOS）。 */
const ARRAY_OUT_OF_BOUNDS_PATTERNS = [
    /std::out_of_range/i,
    /vector::_M_range_check/i,
    /vector subscript out of range/i,
    /Index was outside the bounds/i,
    /array subscript out of (bounds|range)/i,
    /heap-buffer-overflow/i,
    /stack-buffer-overflow/i,
    /global-buffer-overflow/i,
    /buffer overflow/i,
    /index out of (bounds|range)/i,
];

/** 栈溢出相关模式。 */
const STACK_OVERFLOW_PATTERNS = [
    /stack overflow/i,
    /StackOverflow/i,
    /exceeded maximum recursion depth/i,
    /__stack_chk_fail/i,
];

/** 段错误 / 非法内存访问相关模式。 */
const SEGMENTATION_FAULT_PATTERNS = [
    /segmentation fault/i,
    /SIGSEGV/i,
    /segfault/i,
    /access violation/i,
    /invalid memory access/i,
    /SIGABRT/i,
    /aborted[\s\S]*core dumped/i,
];

function combinedText(input: RunErrorClassifierInput): string {
    return `${input.stdout}\n${input.stderr}`;
}

function matchesAny(text: string, patterns: RegExp[]): boolean {
    return patterns.some((pattern) => pattern.test(text));
}

export function classifyRunError(input: RunErrorClassifierInput): RunErrorClassification {
    // 1. 交互兜底：程序在等待更多输入，优先级最高。
    if (input.needsInteractiveInput) {
        return { kind: 'runtime_interactive_input_needed', confidence: 'high' };
    }

    // 2. 硬超时：被运行器主动杀死。
    if (input.timedOut) {
        return { kind: 'runtime_time_limit_exceeded', confidence: 'high' };
    }

    const text = combinedText(input);

    // 3. 数组越界 / 缓冲区溢出。
    if (matchesAny(text, ARRAY_OUT_OF_BOUNDS_PATTERNS)) {
        return { kind: 'runtime_array_out_of_bounds', confidence: 'high' };
    }

    // 4. 栈溢出。
    if (matchesAny(text, STACK_OVERFLOW_PATTERNS)) {
        return { kind: 'runtime_stack_overflow', confidence: 'high' };
    }

    // 5. 段错误 / 非法内存访问。
    if (matchesAny(text, SEGMENTATION_FAULT_PATTERNS)) {
        return { kind: 'runtime_segmentation_fault', confidence: 'medium' };
    }

    // 6. 退出码非零但无明确模式：未知运行时错误。
    if (input.exitCode !== 0) {
        return { kind: 'runtime_unknown', confidence: 'low' };
    }

    // 7. 理论上不会被调用（调用方应只在失败时调用）。
    return { kind: 'runtime_unknown', confidence: 'low' };
}
