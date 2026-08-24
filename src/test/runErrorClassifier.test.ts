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

describe('classifyRunError 覆盖面扩充(20260824)', () => {
    it('S1 用户实测:terminate 包装的 std::bad_alloc → 内存申请失败(medium)', () => {
        const stderr = [
            "terminate called after throwing an instance of 'std::bad_alloc'",
            '  what():  std::bad_alloc',
        ].join('\n');
        const result = classifyRunError(input({ exitCode: 134, stderr }));
        assert.strictEqual(result.kind, 'runtime_memory_alloc_failed');
        assert.strictEqual(result.confidence, 'medium');
    });

    it('S2 无 what() 行的 bad_alloc 变体 → 内存申请失败', () => {
        const result = classifyRunError(input({
            exitCode: 134,
            stderr: "terminate called after throwing an instance of 'std::bad_alloc'",
        }));
        assert.strictEqual(result.kind, 'runtime_memory_alloc_failed');
    });

    it('泄漏型 bad_alloc(无 terminate 包装)也归内存申请失败而非数组越界', () => {
        const result = classifyRunError(input({ exitCode: 134, stderr: 'std::bad_alloc' }));
        assert.strictEqual(result.kind, 'runtime_memory_alloc_failed');
        assert.strictEqual(result.confidence, 'medium');
    });

    it('S4 std::length_error(vector::reserve 超大长度)→ 内存申请失败(medium)', () => {
        const stderr = [
            "terminate called after throwing an instance of 'std::length_error'",
            '  what():  vector::_M_default_append',
        ].join('\n');
        const result = classifyRunError(input({ exitCode: 134, stderr }));
        assert.strictEqual(result.kind, 'runtime_memory_alloc_failed');
        assert.strictEqual(result.confidence, 'medium');
    });

    it('S9 what() 单空格顶格变体(length_error)→ 解包只看类名行,不受缩进影响', () => {
        const stderr = [
            "terminate called after throwing an instance of 'std::length_error'",
            'what(): basic_string::_M_create',
        ].join('\n');
        const result = classifyRunError(input({ exitCode: 134, stderr }));
        assert.strictEqual(result.kind, 'runtime_memory_alloc_failed');
    });

    it('S3 std::bad_array_new_length → 数组越界(high),不进内存申请失败档', () => {
        const stderr = [
            "terminate called after throwing an instance of 'std::bad_array_new_length'",
            '  what():  bad array new length',
        ].join('\n');
        const result = classifyRunError(input({ exitCode: 134, stderr }));
        assert.strictEqual(result.kind, 'runtime_array_out_of_bounds');
        assert.strictEqual(result.confidence, 'high');
        assert.notStrictEqual(result.kind, 'runtime_memory_alloc_failed');
    });

    it('S6 terminate 包装 map::at(out_of_range)→ 数组越界(high)', () => {
        const stderr = [
            "terminate called after throwing an instance of 'std::out_of_range'",
            '  what(): map::at',
        ].join('\n');
        const result = classifyRunError(input({ exitCode: 134, stderr }));
        assert.strictEqual(result.kind, 'runtime_array_out_of_bounds');
        assert.strictEqual(result.confidence, 'high');
    });

    it('S7 自定义异常类 MyError → unknown 升 medium 并附事实性描述(不是段错误、不是 low)', () => {
        const stderr = [
            "terminate called after throwing an instance of 'MyError'",
            '  what():  something bad',
        ].join('\n');
        const result = classifyRunError(input({ exitCode: 134, stderr }));
        assert.strictEqual(result.kind, 'runtime_unknown');
        assert.strictEqual(result.confidence, 'medium');
        assert.ok(result.detail?.includes('MyError'), 'detail 应转述内层异常类名');
        assert.ok(!result.detail?.includes('段错误'));
    });

    it('S8 terminate called without an active exception → unknown(medium)', () => {
        const result = classifyRunError(input({
            exitCode: 134,
            stderr: 'terminate called without an active exception',
        }));
        assert.strictEqual(result.kind, 'runtime_unknown');
        assert.strictEqual(result.confidence, 'medium');
    });

    it('S10 MSVC Debug Error! abort() has been called → unknown(medium)', () => {
        const stderr = ['Debug Error!', '', 'Program: main.exe', '', 'abort() has been called'].join('\n');
        const result = classifyRunError(input({ exitCode: 3, stderr }));
        assert.strictEqual(result.kind, 'runtime_unknown');
        assert.strictEqual(result.confidence, 'medium');
    });

    it('S19 MSVC assert 失败 → 断言失败档(medium)', () => {
        const result = classifyRunError(input({
            exitCode: 3,
            stderr: 'Assertion failed: n > 0, file main.cpp, line 24',
        }));
        assert.strictEqual(result.kind, 'runtime_assertion_failed');
        assert.strictEqual(result.confidence, 'medium');
    });

    it('S19 glibc 风格断言(Assertion `n > 0` failed.)→ 断言失败档', () => {
        const result = classifyRunError(input({
            exitCode: 134,
            stderr: "a.out: main.cpp:24: main: Assertion `n > 0' failed.",
        }));
        assert.strictEqual(result.kind, 'runtime_assertion_failed');
    });

    it('S20 Linux SIGFPE(Floating point exception)→ 算术异常档(medium),不再误入段错误', () => {
        const result = classifyRunError(input({
            exitCode: 136,
            stderr: 'Floating point exception (core dumped)',
        }));
        assert.strictEqual(result.kind, 'runtime_arithmetic_exception');
        assert.strictEqual(result.confidence, 'medium');
    });

    it('S20 MinGW 整数除零(0xC0000094 / integer divide by zero)→ 同归算术异常档', () => {
        const ntstatus = classifyRunError(input({
            exitCode: 3221225620,
            stderr: 'Exception 0xc0000094 INTEGER_DIVIDE_BY_ZERO',
        }));
        assert.strictEqual(ntstatus.kind, 'runtime_arithmetic_exception');

        const textForm = classifyRunError(input({
            exitCode: 136,
            stderr: 'integer divide by zero',
        }));
        assert.strictEqual(textForm.kind, 'runtime_arithmetic_exception');
    });

    it('S18 STATUS_STACK_OVERFLOW 文本(0xc00000fd)→ 栈溢出(high)', () => {
        const result = classifyRunError(input({
            exitCode: 3221225725,
            stderr: 'Exception 0xc00000fd STACK_OVERFLOW at 0x00f412ab',
        }));
        assert.strictEqual(result.kind, 'runtime_stack_overflow');
        assert.strictEqual(result.confidence, 'high');
    });

    it('stack smashing detected(__stack_chk_fail)按文档推荐归数组越界(medium)', () => {
        const smashing = classifyRunError(input({
            exitCode: 134,
            stderr: '*** stack smashing detected ***: terminated',
        }));
        assert.strictEqual(smashing.kind, 'runtime_array_out_of_bounds');
        assert.strictEqual(smashing.confidence, 'medium');

        // 回归护栏:__stack_chk_fail 已从栈溢出表移至栈 smashing 判定。
        const chkFail = classifyRunError(input({
            exitCode: 134,
            stderr: '__stack_chk_fail_local',
        }));
        assert.strictEqual(chkFail.kind, 'runtime_array_out_of_bounds');
        assert.notStrictEqual(chkFail.kind, 'runtime_stack_overflow');
    });

    it('B3 回归:未捕获异常的 Aborted (core dumped) 不得判段错误(无其他线索 → unknown low)', () => {
        const result = classifyRunError(input({
            exitCode: 134,
            stderr: 'Aborted (core dumped)',
        }));
        assert.notStrictEqual(result.kind, 'runtime_segmentation_fault');
        assert.strictEqual(result.kind, 'runtime_unknown');
    });

    it('B3 回归:字面 SIGABRT 出现在 stderr 也不判段错误', () => {
        const result = classifyRunError(input({
            exitCode: 134,
            stderr: 'Program received signal SIGABRT, Aborted.',
        }));
        assert.notStrictEqual(result.kind, 'runtime_segmentation_fault');
        assert.strictEqual(result.kind, 'runtime_unknown');
    });

    it('exit code 启发式:stderr 为空且 exit=3221225477(0xC0000005)→ 段错误(low)', () => {
        const result = classifyRunError(input({ exitCode: 3221225477, stderr: '' }));
        assert.strictEqual(result.kind, 'runtime_segmentation_fault');
        assert.strictEqual(result.confidence, 'low');
    });

    it('exit code 启发式:stderr 为空但 stdout 有输出时仍生效(exit=3221225477)', () => {
        const result = classifyRunError(input({
            exitCode: 3221225477,
            stdout: 'please input n:',
            stderr: '',
        }));
        assert.strictEqual(result.kind, 'runtime_segmentation_fault');
        assert.strictEqual(result.confidence, 'low');
    });

    it('exit code 启发式:exit=3221225725(0xC00000FD)且 stderr 为空 → 栈溢出(low)', () => {
        const result = classifyRunError(input({ exitCode: 3221225725, stderr: '' }));
        assert.strictEqual(result.kind, 'runtime_stack_overflow');
        assert.strictEqual(result.confidence, 'low');
    });

    it('exit code 启发式:文档未收录的码宁落 unknown(low)不编造', () => {
        const result = classifyRunError(input({ exitCode: 3221225620, stderr: '' }));
        assert.strictEqual(result.kind, 'runtime_unknown');
        assert.strictEqual(result.confidence, 'low');
    });

    it('exit code 启发式不覆盖显式证据:stderr 有模式时优先文本匹配', () => {
        const result = classifyRunError(input({
            exitCode: 3221225477,
            stderr: 'Segmentation fault (core dumped)',
        }));
        assert.strictEqual(result.kind, 'runtime_segmentation_fault');
        assert.strictEqual(result.confidence, 'medium');
    });
});
