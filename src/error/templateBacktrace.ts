import type { ParsedError } from './errorParser';
import { extractErrorLocation, parseCompilerStderrWithIncludes } from './errorParser';

/**
 * 模板实例化回溯链解析(P5a,设计依据 cpp-template-error-parsing-research-20260825.md §3.2)。
 *
 * 背景:初学者对模板/STL 的误用会让编译器一路实例化进标准库头文件,叶子
 * `error:` 落在 STL 内部(如 stl_algo.h:1914),真正的根因(学生那行调用)只在
 * 实例化链帧里。本模块在 include 栈解析(parseCompilerStderrWithIncludes)之上,
 * 从原始 stderr 行识别链帧并挂到叶子诊断的 `templateChain` 字段:
 *
 *   stl_algo.h: In instantiation of 'void std::__sort(...) [with ... = _List_iterator<int>]':
 *   stl_algo.h:4817:18:   required from 'void std::sort(...) [with ...]'
 *   c1_sort_list.cpp:7:14:   required from here      ← 链尾,指向学生代码行
 *   stl_algo.h:1914:50: error: no match for 'operator-' ...   ← 叶子
 *
 * 已实测覆盖(本机 g++ 16.1.0,fixtures 见 tmp-template-error-research/):
 * GCC 16 层级化新观感与 -fno-diagnostics-show-nesting 旧观感,两者链帧行
 * 形态相同(无 severity marker、顶格)。Clang(`note: in instantiation of ...
 * requested here`)与 MSVC(`see reference to ... template instantiation ...
 * being compiled`/`while compiling class template member function`)按官方
 * 文档句式构造样本,本机无编译器实测,单测用例名标注 untested。
 */

/** 模板回溯链上的一帧。 */
export interface TemplateFrame {
    /**
     * instantiation = `In instantiation of '...'` / Clang `in instantiation of ... requested here`
     * / MSVC `see reference to ... being compiled`;
     * required = `required from '...'`;
     * here = `required from here` / `recursively required from here` / Clang 尾帧。
     */
    kind: 'instantiation' | 'required' | 'here';
    file?: string;
    line?: number;
    column?: number;
    /** 引号内的模板签名;here 帧没有。 */
    signature?: string;
    /** 该帧位于系统 include 根(STL/编译器头)而非学生代码。 */
    isSystem: boolean;
    raw: string;
}

/** 叶子诊断携带的模板实例化回溯链;帧按 stderr 输出顺序(最内层在前)。 */
export interface TemplateChain {
    frames: TemplateFrame[];
    /**
     * 归因位置:链上最深(最靠近叶子)的学生代码帧,通常即 `required from
     * here` 指向的行;链全部落在系统头里时缺省(此时叶子自身位置即归因)。
     */
    attributed?: TemplateFrame;
}

export interface TemplateBacktraceOptions {
    /**
     * 工作区根绝对路径,用于绝对路径帧的用户/系统判定;缺省时绝对路径
     * 一律按系统帧处理(相对路径总是学生代码帧)。
     */
    workspaceRoot?: string;
}

/**
 * 最后一帧到叶子之间允许的最大行距。GCC 会在每帧后输出源码摘录行
 * (` 4817 | ...`、`      | ~~~~^`),链尾到叶子通常隔 3-5 行;留足余量,
 * 超过说明这些帧和该 error 无关(防误挂)。
 */
const MAX_FRAME_TO_LEAF_GAP = 25;

const GCC_INSTANTIATION_PHRASE = ': In instantiation of ';
const REQUIRED_FROM_PATTERN = /^(.+?):(\d+):(\d+):\s+required from (?:'(.*)'|(recursively required from )?here)\s*$/;
const CLANG_INSTANTIATION_PATTERN = /^(.+?):(\d+):(\d+):\s+note: in instantiation of (.*) requested here$/;
const MSVC_SEE_REFERENCE_PATTERN =
    /^(.+?)\((\d+)(?:,(\d+))?\):\s*note:\s*(?:see reference to (?:function|class) template instantiation|while compiling class template member function)\s*'(.*)'\s*being compiled\s*$/;

const SYSTEM_PATH_HINTS: RegExp[] = [
    /include[\\/]c\+\+[\\/]/i,
    /[\\/]lib[\\/]gcc[\\/]/i,
    /[\\/]lib[\\/]clang[\\/]/i,
    /\bmingw/i,
    /\bmsys/i,
    /\bucrt64\b/i,
    /\bclang64\b/i,
    /[\\/]usr[\\/]include[\\/]/i,
    /windows kits/i,
    /microsoft visual/i,
];

function looksAbsolute(file: string): boolean {
    return /^[a-zA-Z]:[\\/]/.test(file) || /^[\\/]/.test(file);
}

function normalizePath(value: string): string {
    return value.replace(/[\\/]+/g, '/').toLowerCase().replace(/\/+$/, '');
}

/** 系统 include 根特征(研究文档 §3.2:与 viaIncludes 的主翻译单元判定互补)。 */
export function isSystemTemplateFrameFile(file: string | undefined, workspaceRoot?: string): boolean {
    if (!file) {
        return false;
    }
    if (SYSTEM_PATH_HINTS.some((re) => re.test(file))) {
        return true;
    }
    if (looksAbsolute(file)) {
        if (!workspaceRoot) {
            return true;
        }
        const root = normalizePath(workspaceRoot);
        return !normalizePath(file).startsWith(root + '/');
    }
    // 相对路径(编译命令通常在源码目录下运行)按学生代码帧处理。
    return false;
}

function parseFrame(rawLine: string, options?: TemplateBacktraceOptions): TemplateFrame | undefined {
    // GCC 16 层级化观感会把候选/子诊断整块缩进加 `•`;链帧只在顶层,
    // 行首必须顶格,否则 c3 这类多错误输出里候选详情中的缩进
    // `• required from ...` 会拼出幽灵链。
    if (/^\s/.test(rawLine)) {
        return undefined;
    }
    const trimmed = rawLine.trim();
    if (!trimmed) {
        return undefined;
    }
    const system = (file?: string) => isSystemTemplateFrameFile(file, options?.workspaceRoot);

    // GCC 首帧(可无行号):FILE: In instantiation of 'SIG':
    const instIdx = trimmed.indexOf(GCC_INSTANTIATION_PHRASE);
    if (instIdx > 0 && trimmed.endsWith(':')) {
        const file = trimmed.slice(0, instIdx);
        const signature = trimmed.slice(instIdx + GCC_INSTANTIATION_PHRASE.length + 1, -2);
        return { kind: 'instantiation', file, signature, isSystem: system(file), raw: trimmed };
    }

    const required = REQUIRED_FROM_PATTERN.exec(trimmed);
    if (required) {
        const file = required[1];
        const signature = required[4];
        return {
            kind: signature !== undefined ? 'required' : 'here',
            file,
            line: parseInt(required[2], 10),
            column: parseInt(required[3], 10),
            isSystem: system(file),
            ...(signature !== undefined ? { signature } : {}),
            raw: trimmed,
        };
    }

    // Clang(未实测):FILE:LINE:COL: note: in instantiation of SIG requested here
    const clang = CLANG_INSTANTIATION_PATTERN.exec(trimmed);
    if (clang) {
        const file = clang[1];
        return {
            kind: 'instantiation',
            file,
            line: parseInt(clang[2], 10),
            column: parseInt(clang[3], 10),
            signature: clang[4],
            isSystem: system(file),
            raw: trimmed,
        };
    }

    // MSVC(未实测):FILE(LINE[,COL]): note: see reference to ... 'SIG' being compiled
    const msvc = MSVC_SEE_REFERENCE_PATTERN.exec(trimmed);
    if (msvc) {
        const file = msvc[1];
        return {
            kind: 'instantiation',
            file,
            line: parseInt(msvc[2], 10),
            column: msvc[3] ? parseInt(msvc[3], 10) : undefined,
            signature: msvc[4],
            isSystem: system(file),
            raw: trimmed,
        };
    }

    return undefined;
}

/** 从链帧中取最深(最靠近叶子)的学生代码帧。 */
function findDeepestUserFrame(frames: TemplateFrame[]): TemplateFrame | undefined {
    for (let i = frames.length - 1; i >= 0; i--) {
        if (!frames[i].isSystem) {
            return frames[i];
        }
    }
    return undefined;
}

export interface TemplateChainHit {
    /** 叶子诊断行的 trimmed 原文(用于与 ParsedError.raw 精确对账)。 */
    leafRaw: string;
    chain: TemplateChain;
}

/**
 * 扫描完整 stderr,产出每个模板链及其叶子行。
 *
 * 链状态机:顶格 `In instantiation of`(及 Clang/MSVC 等价句式)开新链;
 * `required from`/`required from here` 逐帧追加;其后的第一个 error/warning
 * 诊断行是叶子,收走当前帧栈。候选列表里的缩进子弹帧已被行首规则排除。
 */
export function collectTemplateChains(stderr: string, options?: TemplateBacktraceOptions): TemplateChainHit[] {
    const hits: TemplateChainHit[] = [];
    const lines = stderr.split(/\r?\n/);
    let pending: TemplateFrame[] = [];
    let pendingEndLine = -1;

    for (let i = 0; i < lines.length; i++) {
        const frame = parseFrame(lines[i], options);
        if (frame) {
            if (frame.kind === 'instantiation') {
                pending = [frame];
            } else {
                // 游离的 required 帧(前面没有 instantiation 开链)不构成链。
                if (pending.length === 0) {
                    continue;
                }
                pending.push(frame);
            }
            pendingEndLine = i;
            continue;
        }

        const parsed = extractErrorLocation(lines[i]);
        if (
            parsed &&
            (parsed.severity === 'error' || parsed.severity === 'warning') &&
            pending.length > 0
        ) {
            if (i - pendingEndLine <= MAX_FRAME_TO_LEAF_GAP) {
                hits.push({
                    leafRaw: parsed.raw,
                    chain: { frames: [...pending], attributed: findDeepestUserFrame(pending) },
                });
            }
            pending = [];
        }
    }

    return hits;
}

/**
 * 把模板回溯链挂到 parseCompilerStderrWithIncludes 的解析结果上。
 *
 * 对账方式:链扫描产出的 leafRaw 是叶子行的 trimmed 原文,与 ParsedError.raw
 * 完全一致;同名行(同一错误重复出现)按输出顺序消费。既有字段语义不变,
 * 仅新增 templateChain 可选字段。
 */
export function attachTemplateBacktrace(
    errors: ParsedError[],
    stderr: string,
    options?: TemplateBacktraceOptions
): ParsedError[] {
    const hits = collectTemplateChains(stderr, options);
    if (hits.length === 0) {
        return errors;
    }
    const queueByRaw = new Map<string, TemplateChainHit[]>();
    for (const hit of hits) {
        const queue = queueByRaw.get(hit.leafRaw);
        if (queue) {
            queue.push(hit);
        } else {
            queueByRaw.set(hit.leafRaw, [hit]);
        }
    }
    for (const parsed of errors) {
        const queue = queueByRaw.get(parsed.raw);
        if (queue && queue.length > 0) {
            parsed.templateChain = queue.shift()!.chain;
        }
    }
    return errors;
}

/**
 * 统一入口:include 栈传播 + 模板回溯链。编译/运行管线落 CompileErrorEvent
 * 前用它替代 parseCompilerStderrWithIncludes,错题本与划词解释即可拿到链。
 */
export function parseCompilerStderrFull(
    stderr: string,
    options?: TemplateBacktraceOptions
): ParsedError[] {
    return attachTemplateBacktrace(parseCompilerStderrWithIncludes(stderr), stderr, options);
}

/**
 * 归因重定位:有学生代码归因帧时,返回一个位置改指学生代码行的浅拷贝
 * (叶子消息等其余字段保留,viaIncludes 描述的是"怎么 include 进 STL 的",
 * 对归因位置是噪音,置空);无归因帧时原样返回,非模板错误零改动。
 */
export function resolveAttributedError(parsed: ParsedError): ParsedError {
    const attributed = parsed.templateChain?.attributed;
    if (!attributed || attributed.file === undefined) {
        return parsed;
    }
    return {
        ...parsed,
        file: attributed.file,
        line: attributed.line,
        column: attributed.column,
        viaIncludes: undefined,
    };
}

/**
 * 一行式链摘要(给 LLM 的 answer prompt 用,英文与既有 prompt 风格一致)。
 * 例:`Root-cause frame: main.cpp:7:14 (required from here); error leaf: stl_algo.h:1914:50`
 */
export function describeTemplateChain(parsed: ParsedError): string | undefined {
    const chain = parsed.templateChain;
    if (!chain) {
        return undefined;
    }
    const leafLoc = `${parsed.file ?? 'unknown'}:${parsed.line ?? '?'}`;
    const attributed = chain.attributed;
    if (!attributed) {
        return `Template instantiation chain stays inside library headers; error leaf: ${leafLoc}`;
    }
    const frameLabel = attributed.kind === 'here' ? 'required from here' : attributed.signature ?? attributed.kind;
    const loc = `${attributed.file ?? 'unknown'}:${attributed.line ?? '?'}${attributed.column !== undefined ? `:${attributed.column}` : ''}`;
    return `Root-cause frame: ${loc} (${frameLabel}); error leaf: ${leafLoc}`;
}

/**
 * 划词解释路径富化:对选区归一化产出的主诊断,从完整编译输出里找它的
 * 模板链,挂上并返回一行摘要;无链时返回 undefined(零改动)。
 */
export function attachSelectionTemplateContext(
    parsed: ParsedError | undefined,
    fullOutput: string,
    options?: TemplateBacktraceOptions
): string | undefined {
    if (!parsed) {
        return undefined;
    }
    const hit = collectTemplateChains(fullOutput, options).find((c) => c.leafRaw === parsed.raw);
    if (!hit) {
        return undefined;
    }
    parsed.templateChain = hit.chain;
    return describeTemplateChain(parsed);
}
