import { createHash } from 'crypto';
import type { DebugEvent } from './types';

/**
 * 事件信封与语义指纹(v2 schema,复测问题 2)。
 *
 * 背景:同一条逻辑错误曾被观察到在 journey 时间线复制出 N 条同貌卡片。
 * 结构性根因在派生层(多翻译单元各自 include 同一坏头文件时,一次构建的
 * stderr 天然含 N 组同签名诊断,buildErrorLifecycles 每 error 条一 lifecycle);
 * 防御层由本文件补齐——每条写入事件带 schemaVersion 与 fingerprint(对语义
 * 字段做稳定哈希,排除时间戳等易变字段),append 在短窗口内同指纹幂等跳过,
 * 消费派生再按指纹折叠一次,双保险。
 */

/**
 * 同指纹事件的幂等跳过/折叠窗口(ms):覆盖同一动作多触发源的亚秒级重放。
 * 上限刻意压在学生「隔几秒再编一次同样的错」的真实间隔之下——窗口外的
 * 同指纹事件是真实的又一次犯错,必须完整保留时间线与版本链历史。
 */
export const SEMANTIC_DEDUPE_WINDOW_MS = 5_000;

/** v2 信封版本号;读取到的无信封旧事件视为 v1(见 DebugJourneyStore.getEvents)。 */
export const EVENT_SCHEMA_VERSION = 2 as const;

/**
 * 确定性序列化:对象键递归排序,数组保持原序(诊断行序有语义)。
 * 同一语义负载无论字段构造顺序如何都得到同一字符串。
 */
export function stableStringify(value: unknown): string {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value ?? null);
    }
    if (Array.isArray(value)) {
        return `[${value.map((item) => stableStringify(item)).join(',')}]`;
    }
    const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/**
 * 事件的语义负载:只含「这条事件说了什么」,排除 id/timestamp/durationMs/
 * exitCode 等易变或每次必然不同的字段——同一条逻辑错误重复到达时指纹不变。
 * parsedErrors 只取 error/warning 的 (file,line,message) 三元组(与 journey
 * 归因同一口径);code_modified 用 before/after 内容哈希区分不同修改。
 */
function semanticPayload(event: DebugEvent): unknown {
    switch (event.type) {
        case 'compile_error':
            return {
                type: event.type,
                fileUri: event.fileUri,
                errors: event.parsedErrors
                    .filter((p) => p.severity === 'error' || p.severity === 'warning')
                    .map((p) => [p.file ?? '', p.line ?? -1, p.message]),
            };
        case 'compile_success':
            return { type: event.type, fileUri: event.fileUri };
        case 'code_modified':
            return {
                type: event.type,
                fileUri: event.fileUri,
                before: hashText(event.before),
                after: hashText(event.after),
            };
        case 'hint_requested':
            return {
                type: event.type,
                fileUri: event.fileUri,
                intent: event.intent,
                userPrompt: event.userPrompt,
            };
        case 'run_error':
            return {
                type: event.type,
                executablePath: event.executablePath,
                exitCode: event.exitCode,
            };
    }
}

function hashText(text: string): string {
    return createHash('sha1').update(text, 'utf-8').digest('hex');
}

/**
 * 事件语义指纹:语义负载的稳定哈希(16 hex 字符)。
 * 对字段顺序无关;时间戳/id/durationMs 等易变字段不参与。
 */
export function computeEventFingerprint(event: DebugEvent): string {
    return hashText(stableStringify(semanticPayload(event)));
}
