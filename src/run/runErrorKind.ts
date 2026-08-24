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
