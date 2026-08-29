import type { DebugEvent } from './types';

/**
 * 题目分组键：文件名去扩展名。main.cpp 与 main.exe 会归并为 main。
 * 这是 compile/run/Journey 共用的无依赖底层 helper。
 */
export function deriveProblemKey(fileUri: string | undefined): string | undefined {
    if (!fileUri) {
        return undefined;
    }
    const base = fileUri.split(/[\\/]/).pop();
    if (!base) {
        return undefined;
    }
    const dot = base.lastIndexOf('.');
    const stem = dot > 0 ? base.slice(0, dot) : base;
    return stem.length > 0 ? stem : undefined;
}

/**
 * 事件级题目分组键(run 条目归属):优先读宿主写事件时算好的 problemKey
 * (题目材料 question.md/PDF 标题),缺省时回退文件名 stem——run 事件优先
 * sourceFileUri(源文件),再退 fileUri(exe 路径),保证 main.cpp ↔ main.exe
 * 归并行为与旧事件派生完全一致。
 */
export function eventProblemKey(event: DebugEvent): string | undefined {
    if (event.problemKey !== undefined && event.problemKey !== '') {
        return event.problemKey;
    }
    if (event.type === 'run_success' || event.type === 'run_error') {
        return deriveProblemKey(event.sourceFileUri) ?? deriveProblemKey(event.fileUri);
    }
    return deriveProblemKey(event.fileUri);
}
