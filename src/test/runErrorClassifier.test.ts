import * as assert from 'assert';
import { describe, it } from 'mocha';
import { classifyRunError } from '../run/runErrorClassifier';

/** 构造器:全缺省为「退出码 0、无输出、无超时」的正常形态。 */
function input(overrides: Partial<Parameters<typeof classifyRunError>[0]> = {}) {
    return {
        exitCode: 1,
        stdout: '',
        stderr: '',
        timedOut: false,
        needsInteractiveInput: false,
        ...overrides,
    };
}

describe('classifyRunError', () => {
    it('needsInteractiveInput 优先级最高:即使同时超时也判等待输入', () => {
        const result = classifyRunError(input({
            needsInteractiveInput: true,
            timedOut: true,
            stderr: 'Segmentation fault',
        }));
        assert.strictEqual(result.kind, 'runtime_interactive_input_needed');
        assert.strictEqual(result.confidence, 'high');
    });

    it('硬超时 → runtime_time_limit_exceeded(high),stderr 内容不影响', () => {
        const result = classifyRunError(input({ timedOut: true }));
        assert.strictEqual(result.kind, 'runtime_time_limit_exceeded');
        assert.strictEqual(result.confidence, 'high');
    });

    it('Linux/libstdc++ 样本:vector::_M_range_check(std::out_of_range)→ 数组越界', () => {
        const stderr = [
            "terminate called after throwing an instance of 'std::out_of_range'",
            "  what():  vector::_M_range_check: __n (which is 5) >= this->size() (which is 3)",
        ].join('\n');
        const result = classifyRunError(input({ exitCode: 134, stderr }));
        assert.strictEqual(result.kind, 'runtime_array_out_of_bounds');
        assert.strictEqual(result.confidence, 'high');
    });

    it('Windows/MSVC 样本:vector subscript out of range → 数组越界', () => {
        const result = classifyRunError(input({
            exitCode: 3,
            stderr: 'Debug Error!\n\nProgram: main.exe\n\nvector subscript out of range',
        }));
        assert.strictEqual(result.kind, 'runtime_array_out_of_bounds');
    });

    it('ASan 样本(heap-buffer-overflow)→ 数组越界', () => {
        const result = classifyRunError(input({
            exitCode: 1,
            stderr: 'ERROR: AddressSanitizer: heap-buffer-overflow on address 0x602000000016',
        }));
        assert.strictEqual(result.kind, 'runtime_array_out_of_bounds');
    });

    it('MinGW 样本:stack overflow 文本 → 栈溢出', () => {
        const result = classifyRunError(input({
            exitCode: 3221225725,
            stderr: 'Program received signal SIGSEGV, Segmentation fault.\n#0 0x004013c4 recursive(): stack overflow detected',
        }));
        // 数组越界模式未命中,栈溢出显式命中且优先于段错误兜底。
        assert.strictEqual(result.kind, 'runtime_stack_overflow');
        assert.strictEqual(result.confidence, 'high');
    });

    it('递归爆栈样本(exceeded maximum recursion depth)→ 栈溢出', () => {
        const result = classifyRunError(input({ stderr: 'exceeded maximum recursion depth' }));
        assert.strictEqual(result.kind, 'runtime_stack_overflow');
    });

    it('Linux 样本:Segmentation fault(core dumped)→ 段错误(medium)', () => {
        const result = classifyRunError(input({
            exitCode: 139,
            stderr: 'Segmentation fault (core dumped)',
        }));
        assert.strictEqual(result.kind, 'runtime_segmentation_fault');
        assert.strictEqual(result.confidence, 'medium');
    });

    it('Windows MinGW 样本:Access violation writing 0x... → 段错误', () => {
        const result = classifyRunError(input({
            exitCode: 3221225477,
            stderr: 'Exception 0xc0000005 ACCESS_VIOLATION writing address 0x00000000',
        }));
        assert.strictEqual(result.kind, 'runtime_segmentation_fault');
    });

    it('无法明确分类的 SIGSEGV 退到 runtime_segmentation_fault(规则兜底)', () => {
        const result = classifyRunError(input({ exitCode: 139, stderr: 'SIGSEGV' }));
        assert.strictEqual(result.kind, 'runtime_segmentation_fault');
    });

    it('退出码非零但无任何可识别模式 → runtime_unknown(low)', () => {
        const result = classifyRunError(input({ exitCode: 1 }));
        assert.strictEqual(result.kind, 'runtime_unknown');
        assert.strictEqual(result.confidence, 'low');
    });

    it('stdout 也参与匹配(stderr 为空时数组越界输出在 stdout 仍可识别)', () => {
        const result = classifyRunError(input({
            stdout: 'terminate called after throwing an instance of \'std::out_of_range\'',
        }));
        assert.strictEqual(result.kind, 'runtime_array_out_of_bounds');
    });
});
