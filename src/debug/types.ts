import type { ParsedError } from '../error/errorParser';
import type { MessageIntent } from '../chat/types';
import type { RunErrorKind } from '../run/runErrorKind';

export type DebugEventType =
    | 'compile_error'
    | 'compile_success'
    | 'run_success'
    | 'run_error'
    | 'hint_requested'
    | 'code_modified';

export interface BaseDebugEvent {
    id: string;
    type: DebugEventType;
    timestamp: number;
    sessionId: string;
    workspaceId: string;
    fileUri?: string;
    /**
     * 题目分组键(run 条目归属):扩展宿主写事件时从题目材料(question.md/
     * PDF 标题,见 debug/problemMaterial.ts)算好;找不到材料时不落字段,
     * 消费方按文件名 stem 回退(eventProblemKey)。旧持久化事件无此字段,
     * 派生照旧。该字段是归并用的派生上下文,不参与语义指纹。
     */
    problemKey?: string;
    /**
     * v2 信封(复测问题 2):写入时由 DebugJourneyStore 固化。旧格式事件无
     * 这两个字段,读取视图统一按 schemaVersion=1 迁移,消费端照读不炸。
     */
    schemaVersion?: 1 | 2;
    /** 语义指纹(eventEnvelope.computeEventFingerprint),幂等去重与折叠键。 */
    fingerprint?: string;
}

export interface CompileErrorEvent extends BaseDebugEvent {
    type: 'compile_error';
    stderr: string;
    parsedErrors: ParsedError[];
    exitCode: number | null;
    durationMs: number;
}

export interface CompileSuccessEvent extends BaseDebugEvent {
    type: 'compile_success';
    exitCode: number | null;
    durationMs: number;
}

export interface RunSuccessEvent extends BaseDebugEvent {
    type: 'run_success';
    exitCode: number | null;
    durationMs: number;
    /**
     * 该 exe 由哪个源文件编译产出(run 条目归属):宿主写事件时归位。
     * 缺省(旧事件/找不到源文件)时消费方回退 fileUri(即 exe 路径)。
     * fileUri 本身保持 exe URI 不变,侧边栏树分组与事件过滤语义不动。
     */
    sourceFileUri?: string;
}

export interface RunErrorEvent extends BaseDebugEvent {
    type: 'run_error';
    executablePath: string;
    stdout?: string;
    stderr?: string;
    exitCode: number | null;
    durationMs: number;
    kind: RunErrorKind;
    /** 事实性描述(仅转述 stderr 出现过的内容，如陌生异常类名)，可为空。 */
    errorDetail?: string;
    /** 同 RunSuccessEvent.sourceFileUri:exe 对应源文件 URI,缺省回退 fileUri。 */
    sourceFileUri?: string;
}

export interface HintRequestedEvent extends BaseDebugEvent {
    type: 'hint_requested';
    intent: MessageIntent;
    userPrompt: string;
    selection?: string;
    relatedCompileEventId?: string;
}

export interface CodeModifiedEvent extends BaseDebugEvent {
    type: 'code_modified';
    before: string;
    after: string;
    diff: string;
    trigger: 'manual' | 'pre_compile' | 'post_compile_error';
    relatedEventId?: string;
}

export type DebugEvent =
    | CompileErrorEvent
    | CompileSuccessEvent
    | RunSuccessEvent
    | RunErrorEvent
    | HintRequestedEvent
    | CodeModifiedEvent;

export interface DebugEventFilter {
    workspaceId?: string;
    fileUri?: string;
    since?: number;
    types?: DebugEventType[];
}

export function isCompileError(event: DebugEvent): event is CompileErrorEvent {
    return event.type === 'compile_error';
}

export function isCompileSuccess(event: DebugEvent): event is CompileSuccessEvent {
    return event.type === 'compile_success';
}

export function isHintRequested(event: DebugEvent): event is HintRequestedEvent {
    return event.type === 'hint_requested';
}

export function isCodeModified(event: DebugEvent): event is CodeModifiedEvent {
    return event.type === 'code_modified';
}

export function isRunSuccess(event: DebugEvent): event is RunSuccessEvent {
    return event.type === 'run_success';
}

export function isRunError(event: DebugEvent): event is RunErrorEvent {
    return event.type === 'run_error';
}
