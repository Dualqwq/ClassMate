import type { ParsedError } from '../error/errorParser';
import type { MessageIntent } from '../chat/types';

export type DebugEventType =
    | 'compile_error'
    | 'compile_success'
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

export interface RunErrorEvent extends BaseDebugEvent {
    type: 'run_error';
    executablePath: string;
    stdout?: string;
    stderr?: string;
    exitCode: number | null;
    durationMs: number;
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
