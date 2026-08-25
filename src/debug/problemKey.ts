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
