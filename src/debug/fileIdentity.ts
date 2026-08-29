/**
 * 文件身份与展示路径的共享纯函数(2026-08-29 跨目录撞名修复)。
 *
 * 背景:Debug Journey 的编译卡与运行卡对同一个文件携带两种 URI 形态——
 * 编译卡取解析诊断行里的报错文件(parsed.file,纯 Windows 路径),运行卡取
 * 事件自带的 sourceFileUri/fileUri(percent 编码 file:// URI);此外还有
 * 分隔符/盘符大小写差异。`deriveProblemKey`(src/debug/problemKey.ts)只取
 * basename stem,修「同一文件双形态重复选项」时会把不同目录的同名文件
 * (problem1/a.cpp 与 problem2/a.cpp)也收敛到一起。
 *
 * 本模块给出「带目录限定的文件身份」:同一真实文件(两种 URI 形态、
 * a.cpp↔a.exe 同目录同 stem)归并,异目录同 stem 文件分开。
 * 目录证据的可信口径:只有**绝对形态**的目录(盘符路径或以 / 开头)才用于
 * 区分;相对目录(make 输出 `src/main.cpp` 这类诊断行)与裸文件名一样视为
 * 「无目录证据」,退回 stem 兜底——与旧版 stem 归并行为兼容,不会让旧事件/
 * 相对路径诊断从归并里消失。
 *
 * 纯字符串逻辑、零 node/vscode 依赖——src 侧 mocha 与 webview esbuild
 * (browser 平台)共用,不得引入 node 内置模块。
 */

/** 规范化后的文件身份:dir 为规范化目录('' 表示输入不含目录信息),stem 为去扩展名文件名。 */
export interface FileIdentity {
    dir: string;
    stem: string;
}

/**
 * 任意文件引用(file:// URI、Windows/POSIX 绝对路径)→ 规范化路径:
 * percent 解码、反斜杠统一为正斜杠、盘符路径剥掉 URI 剥离后的前导斜杠
 * (`file:///c%3A/ws/a.cpp` → `c:/ws/a.cpp`)。大小写不动(展示用),
 * 比较时由调用方按需折叠。
 */
export function normalizeFilePath(fileRef: string): string {
    let p = fileRef;
    if (/^file:\/\//i.test(p)) {
        p = p.slice('file://'.length);
        // 按段解码:单段畸形 percent 序列只影响自己,不毒化整条路径
        // (其余段仍正常解码,盘符剥离等后续步骤照常工作)。
        p = p
            .split('/')
            .map((segment) => {
                try {
                    return decodeURIComponent(segment);
                } catch {
                    return segment;
                }
            })
            .join('/');
    }
    p = p.replace(/\\/g, '/');
    // `file:///c%3A/...` 解码后是 `/c:/...`;盘符路径剥掉前导斜杠,与
    // Windows 纯路径形态(`C:\ws\a.cpp` → `C:/ws/a.cpp`)统一。
    if (/^\/[a-z]:\//i.test(p)) {
        p = p.slice(1);
    }
    return p;
}

/** 目录是否为可信的绝对形态证据(盘符路径或 POSIX 绝对路径;UNC 按绝对对待)。 */
function isAbsoluteDir(dir: string): boolean {
    return dir.startsWith('/') || /^[a-z]:\//i.test(dir);
}

/**
 * 文件引用 → 带目录的文件身份。stem 口径与 deriveProblemKey 一致
 * (最后一个点且点前非空才去扩展名);解析不出 stem 时返回 undefined。
 */
export function deriveFileIdentity(fileRef: string | undefined): FileIdentity | undefined {
    if (!fileRef) {
        return undefined;
    }
    const p = normalizeFilePath(fileRef);
    const slashIndex = p.lastIndexOf('/');
    const dir = slashIndex >= 0 ? p.slice(0, slashIndex) : '';
    const base = slashIndex >= 0 ? p.slice(slashIndex + 1) : p;
    if (!base) {
        return undefined;
    }
    const dot = base.lastIndexOf('.');
    const stem = dot > 0 ? base.slice(0, dot) : base;
    if (!stem) {
        return undefined;
    }
    return { dir, stem };
}

/**
 * 两个引用是否指向「同一程序」(文件筛选的 a.cpp↔a.exe 归并语义,加目录限定):
 * stem 相等,且——两侧都有**绝对形态**目录时目录必须相等(盘符/大小写差异
 * 按 Windows 语义折叠,POSIX 保持大小写敏感);任一侧是相对目录或裸文件名
 * (无目录证据)时退回 stem 兜底(旧版行为,宁可信其同——没有证据可反驳,
 * 避免旧事件/相对诊断从归并里消失)。两侧绝对目录不同则绝不归并:异目录
 * 同名文件(problem1/a.cpp 与 problem2/a.cpp)是两个真实文件。
 */
export function sameProgramFile(a: string | undefined, b: string | undefined): boolean {
    const ia = deriveFileIdentity(a);
    const ib = deriveFileIdentity(b);
    if (!ia || !ib) {
        return false;
    }
    if (ia.dir !== '' && ib.dir !== '' && isAbsoluteDir(ia.dir) && isAbsoluteDir(ib.dir)) {
        const windowsLike = /^[a-z]:\//i.test(ia.dir) || /^[a-z]:\//i.test(ib.dir);
        const da = windowsLike ? ia.dir.toLowerCase() : ia.dir;
        const db = windowsLike ? ib.dir.toLowerCase() : ib.dir;
        if (da !== db) {
            return false;
        }
    }
    // stem 比较跟随目录的 Windows 语义折叠大小写(Windows 文件名大小写不敏感;
    // POSIX 侧保持大小写敏感)。
    const windowsLike =
        isAbsoluteDir(ia.dir) && /^[a-z]:\//i.test(ia.dir) ||
        isAbsoluteDir(ib.dir) && /^[a-z]:\//i.test(ib.dir);
    const sa = windowsLike ? ia.stem.toLowerCase() : ia.stem;
    const sb = windowsLike ? ib.stem.toLowerCase() : ib.stem;
    return sa === sb;
}

/**
 * 文件引用 → 学生可读的展示路径(正斜杠):
 * 1. 已知工作区根且文件在根内 → 相对根的路径(如 `problem1/a.cpp`)——筛选
 *    下拉靠它区分异目录同名文件,是本修复的主形态;
 * 2. 已知根但文件在根外(系统头/其他盘) → 规范化绝对路径(诚实展示真实
 *    位置,避免与根内同名文件撞 label);
 * 3. 根未知(无文件夹窗口等退化场景) → 原名(basename)——沿用旧 label
 *    行为,避免把绝对路径噪音带给学生;此时异目录同名文件的 label 可能
 *    相同,但选项 value 仍按完整身份区分、筛选互不串(已知残留,见
 *    CHANGELOG)。
 */
export function formatFileDisplayPath(
    fileRef: string | undefined,
    workspaceRoot?: string
): string | undefined {
    if (!fileRef) {
        return undefined;
    }
    const p = normalizeFilePath(fileRef);
    const slashIndex = p.lastIndexOf('/');
    const base = slashIndex >= 0 ? p.slice(slashIndex + 1) : p;
    if (!workspaceRoot) {
        return base || p;
    }
    const root = normalizeFilePath(workspaceRoot).replace(/\/+$/, '');
    if (!root) {
        return base || p;
    }
    const windowsLike = /^[a-z]:\//i.test(p) || /^[a-z]:\//i.test(root);
    const comparableFile = windowsLike ? p.toLowerCase() : p;
    const comparableRoot = windowsLike ? root.toLowerCase() : root;
    if (comparableFile.startsWith(`${comparableRoot}/`)) {
        // 相对部分取自原始规范化路径,保留文件自身大小写。
        return p.slice(root.length + 1);
    }
    if (comparableFile === comparableRoot) {
        return base || p;
    }
    return p;
}
