/**
 * Run 面板运行错误分类标签。
 *
 * 与编译期知识标签 (`errorKnowledgeMap`) 不同，这些标签描述的是程序运行时的
 * 异常现象，用于 Journey 时间线学生化呈现与错题本分组。
 */

export type RunErrorKind =
    | 'runtime_unknown'
    | 'runtime_array_out_of_bounds'
    | 'runtime_stack_overflow'
    | 'runtime_segmentation_fault'
    | 'runtime_time_limit_exceeded'
    | 'runtime_interactive_input_needed';

export const RUN_ERROR_KINDS: RunErrorKind[] = [
    'runtime_unknown',
    'runtime_array_out_of_bounds',
    'runtime_stack_overflow',
    'runtime_segmentation_fault',
    'runtime_time_limit_exceeded',
    'runtime_interactive_input_needed',
];

/**
 * 学生化文案(Journey 时间线/过滤栏共用,不含内部术语)。
 * 放在本模块:viewModel 与 filters 都要消费,且两者互不 import,
 * 这里是唯一无依赖的公共底层。
 */
export const RUN_ERROR_KIND_LABELS: Record<RunErrorKind, string> = {
    runtime_unknown: '运行出错：原因不明',
    runtime_array_out_of_bounds: '运行出错：数组越界',
    runtime_stack_overflow: '运行出错：栈溢出(常见于过深递归)',
    runtime_segmentation_fault: '运行出错：非法内存访问(段错误)',
    runtime_time_limit_exceeded: '运行出错：超出时限(可能是死循环)',
    runtime_interactive_input_needed: '运行出错：程序在等待输入',
};
