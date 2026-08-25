import {
    RUN_ERROR_KINDS,
    RUN_ERROR_KIND_LABELS,
    type RunErrorKind,
} from './runErrorKind';

/**
 * 运行错误知识卡元数据。
 *
 * 分类只使用上游 `RunErrorKind`，这里不再读取 stdout/stderr 做第二次判断。
 * commonCauses 是排查候选，不代表已经从本次运行中证实；`runtime_unknown`
 * 则只陈述证据不足，不列猜测性病因。
 */
export interface RunErrorKnowledgeConcept {
    kind: RunErrorKind;
    tag: RunErrorKind;
    title: string;
    summary: string;
    commonCauses: string[];
    suggestedFixes: string[];
    checkMethod: string;
    /** 教学用对比例，不是学生真实代码，也不作为 concrete fix。 */
    wrongExample: string;
    /** 教学用对比例，不是学生真实代码，也不作为 concrete fix。 */
    correctExample: string;
}

const RUN_ERROR_KNOWLEDGE: Record<RunErrorKind, RunErrorKnowledgeConcept> = {
    runtime_unknown: {
        kind: 'runtime_unknown',
        tag: 'runtime_unknown',
        title: '原因尚不明确的运行错误',
        summary: '程序没有正常结束，但现有运行输出和退出码不足以唯一判断成因。',
        commonCauses: ['现有证据不足，不能诚实地把问题归到某一种具体原因'],
        suggestedFixes: [
            '保留本次输入、完整标准输出、标准错误和退出码',
            '用同一输入再次运行，确认问题能否稳定复现',
            '逐步缩小触发问题的输入或代码范围，再根据新增证据排查',
        ],
        checkMethod: '先比较多次复现的输入、输出和退出码；只有拿到新的明确证据后再判断具体原因。',
        wrongExample: '// 只有“程序异常退出”这一事实，不能据此猜出具体出错语句',
        correctExample: '// 先记录完整输入、stdout、stderr 与退出码，再依据新增证据定位',
    },
    runtime_array_out_of_bounds: {
        kind: 'runtime_array_out_of_bounds',
        tag: 'runtime_array_out_of_bounds',
        title: '运行期数组或容器越界',
        summary: '运行信息表明数组、缓冲区或容器的边界被越过，或数组长度参数本身不合法。',
        commonCauses: [
            '循环上界把 < 写成 <=',
            '下标小于 0，或大于等于实际元素个数',
            '数组长度或容器大小由未校验的输入计算得到',
        ],
        suggestedFixes: [
            '在访问前同时检查下标下界和上界',
            '把循环边界与容器的实际 size 对照',
            '在申请数组或调整容器长度前校验长度值',
        ],
        checkMethod: '在每次可疑访问前记录下标和 size，检查是否始终满足 0 <= index < size。',
        wrongExample: 'for (std::size_t i = 0; i <= values.size(); ++i) { use(values[i]); }',
        correctExample: 'for (std::size_t i = 0; i < values.size(); ++i) { use(values[i]); }',
    },
    runtime_stack_overflow: {
        kind: 'runtime_stack_overflow',
        tag: 'runtime_stack_overflow',
        title: '栈空间耗尽',
        summary: '运行信息表明调用栈已耗尽；过深递归是常见候选，但仍需结合调用路径确认。',
        commonCauses: [
            '递归缺少可到达的终止条件',
            '递归深度随输入增长得过快',
            '函数局部放置了占用很大的数组或对象',
        ],
        suggestedFixes: [
            '先确认递归的终止条件对当前输入确实可到达',
            '记录递归参数和深度，检查每层是否向终止条件推进',
            '避免在每层调用中创建过大的局部对象',
        ],
        checkMethod: '给递归深度加临时计数并观察参数变化；若没有递归，再检查大体积局部变量。',
        wrongExample: 'void visit(int n) { visit(n + 1); }',
        correctExample: 'void visit(int n) { if (n <= 0) return; visit(n - 1); }',
    },
    runtime_segmentation_fault: {
        kind: 'runtime_segmentation_fault',
        tag: 'runtime_segmentation_fault',
        title: '非法内存访问',
        summary: '程序访问了当前进程无权访问的内存；该现象本身不能唯一确定是哪一个指针或下标。',
        commonCauses: [
            '解引用空指针、悬空指针或未初始化指针',
            '越界访问破坏了相邻内存',
            '对象已经释放却仍被继续使用',
        ],
        suggestedFixes: [
            '从崩溃前最后一次指针解引用或下标访问开始检查',
            '确认对象生命周期覆盖所有使用位置',
            '在可用时结合调试器或地址检查工具查看实际崩溃位置',
        ],
        checkMethod: '在可疑访问前检查指针值、对象生命周期和下标边界，不凭退出码猜具体变量。',
        wrongExample: 'int *p = nullptr; int value = *p;',
        correctExample: 'if (p != nullptr) { int value = *p; }',
    },
    runtime_memory_alloc_failed: {
        kind: 'runtime_memory_alloc_failed',
        tag: 'runtime_memory_alloc_failed',
        title: '内存申请失败',
        summary: '运行信息表明一次内存申请被拒绝，或数组/容器长度超过了实现允许的范围。',
        commonCauses: [
            '数组或容器一次申请的元素数量过大',
            '长度计算溢出或由未校验输入得到异常大的申请量',
            '循环持续扩张容器，导致申请量不断增长',
        ],
        suggestedFixes: [
            '在申请前记录元素数量和单个元素大小',
            '校验长度计算是否溢出、是否超过题目允许范围',
            '检查容器是否在循环中只增长而没有释放或复用',
        ],
        checkMethod: '定位发生申请的数组或容器操作，核对申请元素数、元素大小和长度计算过程。',
        wrongExample: 'std::vector<int> data(uncheckedCount); // uncheckedCount 未校验',
        correctExample: 'if (uncheckedCount <= limit) { std::vector<int> data(uncheckedCount); }',
    },
    runtime_assertion_failed: {
        kind: 'runtime_assertion_failed',
        tag: 'runtime_assertion_failed',
        title: '断言条件不成立',
        summary: '程序执行到了断言，但当时的实际值不满足代码写下的检查条件。',
        commonCauses: [
            '调用方传入了不满足前置条件的数据',
            '前面的状态更新没有维持程序约定',
            '断言条件与真实业务规则不一致',
        ],
        suggestedFixes: [
            '读取断言表达式并记录其中各变量的实际值',
            '向前追踪这些值是在哪里产生或修改的',
            '先确认程序约定，再决定修数据流还是修断言',
        ],
        checkMethod: '以断言表达式为起点，逐项核对变量实际值和它们应满足的前置条件。',
        wrongExample: 'int n = 0; assert(n > 0);',
        correctExample: 'if (n <= 0) { return 1; } assert(n > 0);',
    },
    runtime_arithmetic_exception: {
        kind: 'runtime_arithmetic_exception',
        tag: 'runtime_arithmetic_exception',
        title: '运行期算术异常',
        summary: '运行信息表明处理器报告了算术异常；现有分类可能对应整数除零，也可能对应其他浮点异常。',
        commonCauses: [
            '整数除数在运行时变成 0',
            '浮点环境报告了无效运算、溢出或除零',
            '输入和中间计算没有满足运算的定义域',
        ],
        suggestedFixes: [
            '在除法或取模前检查除数',
            '记录参与运算的实际输入和中间值',
            '按题目约束处理不在运算定义域内的输入',
        ],
        checkMethod: '从出错输入出发，检查每个除法、取模和可能触发浮点异常的表达式实际操作数。',
        wrongExample: 'int result = total / count; // count 可能为 0',
        correctExample: 'if (count != 0) { int result = total / count; }',
    },
    runtime_time_limit_exceeded: {
        kind: 'runtime_time_limit_exceeded',
        tag: 'runtime_time_limit_exceeded',
        title: '运行超出时间限制',
        summary: '程序在运行器给定的时间内没有结束；这不等同于已经证明存在死循环。',
        commonCauses: [
            '循环条件一直为真，循环变量没有向退出条件推进',
            '算法复杂度对当前输入过高',
            '程序在等待某个不会到来的状态或资源',
        ],
        suggestedFixes: [
            '记录循环关键变量，确认每轮都向退出条件推进',
            '缩小输入并比较运行时间随规模的变化',
            '区分持续计算、等待输入与等待外部状态',
        ],
        checkMethod: '先用小输入复现，再观察程序停在哪个循环或等待点；只有拿到证据后再判断是否死循环。',
        wrongExample: 'while (i < n) { process(i); } // i 没有变化',
        correctExample: 'while (i < n) { process(i); ++i; }',
    },
    runtime_interactive_input_needed: {
        kind: 'runtime_interactive_input_needed',
        tag: 'runtime_interactive_input_needed',
        title: '程序仍在等待输入',
        summary: '运行器已经提供了当前输入，但程序还在等待更多交互式输入。',
        commonCauses: [
            '程序读取的输入项比 Run 面板中提供的更多',
            '读取循环的结束条件依赖额外输入或文件结束标记',
            '题目本身要求逐步交互，不适合一次性输入运行',
        ],
        suggestedFixes: [
            '逐项数清程序会执行多少次输入读取',
            '让 Run 面板输入与程序预期的格式和数量一致',
            '确属交互式程序时，改用集成终端手动运行',
        ],
        checkMethod: '沿实际控制流列出每个输入读取点，并与本次提供的输入逐项对照。',
        wrongExample: '// 程序要读取两个整数，但本次只提供了一个',
        correctExample: '// 一次性提供完整输入；若题目要求交互，则在集成终端中运行',
    },
};

export function listRunErrorKnowledgeConcepts(): RunErrorKnowledgeConcept[] {
    return RUN_ERROR_KINDS.map((kind) => RUN_ERROR_KNOWLEDGE[kind]);
}

export function getRunErrorKnowledgeConcept(
    kind: RunErrorKind
): RunErrorKnowledgeConcept {
    return RUN_ERROR_KNOWLEDGE[kind];
}

/** 只拼接事件已有事实：分类标签、退出码、分类器传下来的 errorDetail。 */
export function formatRunErrorPhenomenon(
    kind: RunErrorKind,
    exitCode: number | null,
    errorDetail?: string
): string {
    const base = `${RUN_ERROR_KIND_LABELS[kind]}(退出码 ${exitCode ?? '未知'})`;
    return errorDetail ? `${base}；${errorDetail}` : base;
}
