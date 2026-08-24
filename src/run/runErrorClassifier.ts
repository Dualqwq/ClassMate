import type { RunErrorKind } from './runErrorKind';

/**
 * Run 错误分类器(#12b/#14b)。
 *
 * 纯函数：输入运行结果，输出 { kind, confidence, detail? }。
 * 覆盖设计见 docs/run-error-classifier-coverage-design.md：
 * - Windows MinGW/MSVC 与 Linux/macOS 的常见 stderr 模式；
 * - terminate 包装解包：提取内层异常类名查映射表，陌生类名 → unknown(medium)
 *   并附事实性描述(只转述 stderr 出现过的类名，不推断成因)；
 * - stderr 为空时按 Windows NTSTATUS 退出码启发式兜底(low)；
 * - 完全无法识别退到 runtime_unknown。
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
    /** 事实性描述(仅转述 stderr 中出现过的内容)，Journey 详情行展示。 */
    detail?: string;
}

/** 数组越界 / 缓冲区溢出的显式证据（Windows MinGW + Linux/macOS）。 */
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
    // new[] 收到负数/超大长度参数的直接证据：越界结论成立，归数组越界而非分配失败。
    /std::bad_array_new_length/i,
];

/**
 * 栈保护检测到越界写(canary 被写穿)：证据指向数组越界，
 * 但破坏也可能来自被调库，降为 medium。
 */
const STACK_SMASHING_PATTERNS = [/__stack_chk_fail/i, /stack smashing detected/i];

/** 栈溢出的显式证据。 */
const STACK_OVERFLOW_PATTERNS = [
    /stack overflow/i,
    /StackOverflow/i,
    /exceeded maximum recursion depth/i,
    /0xc00000fd/i,
    /STATUS_STACK_OVERFLOW/i,
];

/** 内存申请失败的显式证据(bad_alloc / length_error)。 */
const MEMORY_ALLOC_FAILED_PATTERNS = [/std::bad_alloc/i, /std::length_error/i];

/** 断言失败(MSVC「Assertion failed: …」与 glibc「Assertion `x' failed.」)。 */
const ASSERTION_FAILED_PATTERNS = [/assertion[^\n]*failed/i];

/** 算术异常(SIGFPE / 整数除零)：x86 上整数除零也报 Floating point exception，两类合并并诚实说明。 */
const ARITHMETIC_EXCEPTION_PATTERNS = [
    /\bSIGFPE\b/i,
    /floating point exception/i,
    /0xc0000094/i,
    /STATUS_INTEGER_DIVIDE_BY_ZERO/i,
    /integer divide by zero/i,
];

/** 段错误 / 非法内存访问的显式证据(SIGABRT 与 aborted…core dumped 属"怎么死的"不是"为什么死"，不在此表)。 */
const SEGMENTATION_FAULT_PATTERNS = [
    /segmentation fault/i,
    /SIGSEGV/i,
    /segfault/i,
    /access[ _-]?violation/i,
    /0xc0000005/i,
    /invalid memory access/i,
];

/** terminate 包装解包后的内层异常类名 → 分类映射(包装层不是病因)。 */
const INNER_EXCEPTION_CLASSIFICATION: Record<string, RunErrorClassification> = {
    'std::out_of_range': { kind: 'runtime_array_out_of_bounds', confidence: 'high' },
    'std::bad_array_new_length': { kind: 'runtime_array_out_of_bounds', confidence: 'high' },
    'std::bad_alloc': { kind: 'runtime_memory_alloc_failed', confidence: 'medium' },
    'std::length_error': { kind: 'runtime_memory_alloc_failed', confidence: 'medium' },
};

const TERMINATE_THROW_PATTERN = /terminate called after throwing an instance of '([^']+)'/;

/** 无活跃异常的 terminate(noexcept 函数抛出、线程析构时仍有异常等)。 */
const TERMINATE_WITHOUT_ACTIVE_EXCEPTION = /terminate called without an active exception/i;

/** MSVC Debug CRT 的 abort 文案(zh-CN 系统上可能本地化，靠 exit code 启发式兜底)。 */
const ABORT_CALLED_PATTERN = /abort\(\) has been called/i;

/**
 * Windows NTSTATUS 退出码启发式(stderr 为空时的最后线索)。
 * 只收录有明确依据的码，宁落 unknown 不编造：
 * - 3221225477 = 0xC0000005 ACCESS_VIOLATION；
 * - 3221225725 = 0xC00000FD STATUS_STACK_OVERFLOW。
 */
const EXIT_CODE_HEURISTICS: Array<{ code: number; classification: RunErrorClassification }> = [
    { code: 3221225477, classification: { kind: 'runtime_segmentation_fault', confidence: 'low' } },
    { code: 3221225725, classification: { kind: 'runtime_stack_overflow', confidence: 'low' } },
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

    // 3. 数组越界 / 缓冲区溢出(high)。
    if (matchesAny(text, ARRAY_OUT_OF_BOUNDS_PATTERNS)) {
        return { kind: 'runtime_array_out_of_bounds', confidence: 'high' };
    }

    // 4. 栈溢出(high)。
    if (matchesAny(text, STACK_OVERFLOW_PATTERNS)) {
        return { kind: 'runtime_stack_overflow', confidence: 'high' };
    }

    // 5. 栈 smashing：指向越界写但可能来自被调库，数组越界(medium)。
    if (matchesAny(text, STACK_SMASHING_PATTERNS)) {
        return { kind: 'runtime_array_out_of_bounds', confidence: 'medium' };
    }

    // 6. 内存申请失败(medium)。
    if (matchesAny(text, MEMORY_ALLOC_FAILED_PATTERNS)) {
        return { kind: 'runtime_memory_alloc_failed', confidence: 'medium' };
    }

    // 7. 断言失败(medium)。
    if (matchesAny(text, ASSERTION_FAILED_PATTERNS)) {
        return { kind: 'runtime_assertion_failed', confidence: 'medium' };
    }

    // 8. 算术异常：整数除零与浮点运算异常在 x86 上文案相同，诚实归并(medium)。
    if (matchesAny(text, ARITHMETIC_EXCEPTION_PATTERNS)) {
        return { kind: 'runtime_arithmetic_exception', confidence: 'medium' };
    }

    // 9. 段错误 / 非法内存访问(medium)。
    if (matchesAny(text, SEGMENTATION_FAULT_PATTERNS)) {
        return { kind: 'runtime_segmentation_fault', confidence: 'medium' };
    }

    // 10. terminate 解包：整体匹配未命中时提取内层异常类名查映射表。
    const thrownMatch = TERMINATE_THROW_PATTERN.exec(text);
    if (thrownMatch) {
        const inner = INNER_EXCEPTION_CLASSIFICATION[thrownMatch[1]];
        if (inner) {
            return { ...inner };
        }
        // 陌生/自定义类名：只转述事实，不推断成因(unknown 升 medium)。
        return {
            kind: 'runtime_unknown',
            confidence: 'medium',
            detail: `程序抛出了一个未被处理的异常（类型：${thrownMatch[1]}）`,
        };
    }
    if (
        TERMINATE_WITHOUT_ACTIVE_EXCEPTION.test(text) ||
        ABORT_CALLED_PATTERN.test(text)
    ) {
        return { kind: 'runtime_unknown', confidence: 'medium' };
    }

    // 11. exit code 启发式：stderr 为空时按 Windows 崩溃码兜底(low)。
    if (input.stderr.trim() === '' && input.exitCode !== null) {
        const heuristic = EXIT_CODE_HEURISTICS.find((entry) => entry.code === input.exitCode);
        if (heuristic) {
            return { ...heuristic.classification };
        }
    }

    // 12. 退出码非零但无任何可识别模式：未知运行时错误。
    if (input.exitCode !== 0) {
        return { kind: 'runtime_unknown', confidence: 'low' };
    }

    // 13. 理论上不会被调用（调用方应只在失败时调用）。
    return { kind: 'runtime_unknown', confidence: 'low' };
}
