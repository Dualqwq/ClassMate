import type { LLMMessage } from '../llm/types';
import type { JourneySummary } from './debugJourneySummary';
import { buildJourneySummary } from './debugJourneySummary';
import type { KnowledgeCard, ConcreteFix } from './knowledgeCard';
import { buildKnowledgeCards } from './knowledgeCardBuilder';
import type { DebugJourneyStore } from './debugJourneyStore';
import { formatFixWithContext } from './formatDiff';

export interface DebugNotebookOptions {
    /** Maximum knowledge cards to include in the notebook. */
    maxCards?: number;
    /** Maximum concrete fixes per card. */
    maxFixesPerCard?: number;
    /** Unchanged context lines shown around each hunk in a diff. */
    diffContextLines?: number;
    /** Maximum diagnostics shown per compile_error source event. */
    maxDiagnosticsPerError?: number;
}

export interface DebugNotebookInput {
    workspaceId: string;
    generatedAt: string;
    summary: JourneySummary;
    cards: KnowledgeCard[];
}

export interface NotebookPrompt {
    messages: LLMMessage[];
    estimatedInputTokens: number;
}

export interface SerializableFix {
    before: string;
    after: string;
    diff: string;
}

export interface SerializableCard {
    tag: string;
    title: string;
    summary: string;
    commonCauses: string[];
    suggestedFixes: string[];
    checkMethod: string;
    wrongExample: string;
    correctExample: string;
    frequency: number;
    resolvedCount: number;
    unresolvedCount: number;
    avgFixAttempts: number;
    concreteFixes: SerializableFix[];
    /** 事件已有的运行现象；缺省表示编译卡沿用诊断链路。 */
    phenomenon?: string;
    problemKey?: string;
}

export interface SerializableSummary {
    totalEvents: number;
    compileErrors: number;
    compileSuccesses: number;
    runErrors: number;
    avgFixAttempts: number;
    helpSeekingRatio: number;
    independentFixRatio: number;
    topTags: { tag: string; count: number }[];
    suggestedSteps: string[];
}

const DEFAULT_MAX_CARDS = 10;
const DEFAULT_MAX_FIXES_PER_CARD = 2;
const DEFAULT_DIFF_CONTEXT_LINES = 2;

function estimateTokens(text: string): number {
    // Rough heuristic: ~4 characters per token for mixed CJK/English text.
    return Math.ceil(text.length / 4);
}

function toSerializableSummary(summary: JourneySummary): SerializableSummary {
    const topTags = Object.entries(summary.errorStats.byKnowledgeTag)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([tag, count]) => ({ tag, count }));

    return {
        totalEvents: summary.totalEvents,
        compileErrors: summary.errorStats.totalCompileErrors,
        compileSuccesses: summary.errorStats.totalCompileSuccesses,
        runErrors: summary.errorStats.totalRunErrors,
        avgFixAttempts: summary.metrics.avgFixAttempts,
        helpSeekingRatio: summary.metrics.helpSeekingRatio,
        independentFixRatio: summary.metrics.independentFixRatio,
        topTags,
        suggestedSteps: summary.suggestedSteps.slice(0, 10),
    };
}

function toSerializableCard(
    card: KnowledgeCard,
    options: Required<Pick<DebugNotebookOptions, 'maxFixesPerCard' | 'diffContextLines'>>
): SerializableCard {
    const concreteFixes = card.concreteFixes
        .slice(0, options.maxFixesPerCard)
        .map((fix) => ({
            before: fix.before,
            after: fix.after,
            diff: formatFixWithContext(fix.before, fix.after, options.diffContextLines),
        }));

    return {
        tag: card.tag,
        title: card.title,
        summary: card.summary,
        commonCauses: card.commonCauses.slice(0, 6),
        suggestedFixes: card.suggestedFixes.slice(0, 6),
        checkMethod: card.checkMethod,
        wrongExample: card.wrongExample,
        correctExample: card.correctExample,
        frequency: card.frequency,
        resolvedCount: card.resolvedCount,
        unresolvedCount: card.unresolvedCount,
        avgFixAttempts: card.avgFixAttempts,
        concreteFixes,
        phenomenon: card.phenomenon,
        problemKey: card.problemKey,
    };
}

export async function buildNotebookInput(
    store: DebugJourneyStore,
    options?: DebugNotebookOptions
): Promise<DebugNotebookInput> {
    const maxFixesPerCard = options?.maxFixesPerCard ?? DEFAULT_MAX_FIXES_PER_CARD;
    const summary = await buildJourneySummary(store);
    const cards = await buildKnowledgeCards(store, { maxConcreteExamples: maxFixesPerCard });

    return {
        workspaceId: store.workspaceId,
        generatedAt: new Date().toISOString(),
        summary,
        cards,
    };
}

function buildDynamicContent(
    input: DebugNotebookInput,
    options: Required<Pick<DebugNotebookOptions, 'maxCards' | 'maxFixesPerCard' | 'diffContextLines'>>
): string {
    const summary = toSerializableSummary(input.summary);
    const cards = input.cards
        .slice(0, options.maxCards)
        .map((card) => toSerializableCard(card, { maxFixesPerCard: options.maxFixesPerCard, diffContextLines: options.diffContextLines }));

    return JSON.stringify(
        {
            workspaceId: input.workspaceId,
            generatedAt: input.generatedAt,
            summary,
            cards,
        },
        null,
        2
    );
}

export function buildNotebookPrompt(
    input: DebugNotebookInput,
    options?: DebugNotebookOptions
): NotebookPrompt {
    const maxCards = options?.maxCards ?? DEFAULT_MAX_CARDS;
    const maxFixesPerCard = options?.maxFixesPerCard ?? DEFAULT_MAX_FIXES_PER_CARD;
    const diffContextLines = options?.diffContextLines ?? DEFAULT_DIFF_CONTEXT_LINES;

    const systemPrompt = [
        '你是一位耐心的编程助教，正在帮助大一/大二学生学习 C/C++ 编程。',
        '请根据下面提供的 Debug Journey 数据，生成一份 Markdown 格式的“错题本”。',
        '',
        '错题本应包含以下部分：',
        '1. 封面：标题、生成时间、所属工作区。',
        '2. 总体回顾：本次调试历程的关键数字（编译错误次数、成功次数、平均修复尝试次数、求助比例等）。',
        '3. 知识点卡片：每张卡片对应一个常见错误类型，按未解决优先、频率次之的顺序排列。',
        '   每张卡片内部包含：',
        '   - 问题描述（用学生能理解的中文解释这个错误）',
        '   - 错误现象（典型报错或现象）',
        '   - 原因分析（为什么会出现这个错误）',
        '   - 涉及知识点',
        '   - 修改思路',
        '   - 关键代码 diff（保留 ```diff 代码块，用 `-` 表示删除、`+` 表示新增；上下文行前面保留两个空格）',
        '   - 复习建议',
        '4. 学习建议：基于总体数据给出 3-5 条可执行的后续学习建议。',
        '',
        '写作风格：',
        '- 使用中文。',
        '- 简洁、具体、初学者友好。',
        '- 不要指责学生，避免“很简单”“显然”等表达。',
        '- 不直接给出完整答案，重点在帮助学生理解错误和修改方向。',
        '- diff 代码块必须完整保留，便于学生对照。',
        '- phenomenon 是本次事件已有的事实；不得把常见原因写成已经证实的根因。',
        '- wrongExample/correctExample 是概念教学示例，不是学生代码或学生真实修复。',
        '- concreteFixes 为空时不得编造修改 diff；runtime_unknown 不得猜测具体成因。',
        '',
        '输出只包含 Markdown 正文，不要包含额外的解释或元评论。',
    ].join('\n');

    const dynamicContent = buildDynamicContent(input, { maxCards, maxFixesPerCard, diffContextLines });

    const messages: LLMMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `请根据以下 Debug Journey 数据生成错题本：\n\n\`\`\`json\n${dynamicContent}\n\`\`\`` },
    ];

    const estimatedInputTokens = estimateTokens(systemPrompt) + estimateTokens(dynamicContent);

    return { messages, estimatedInputTokens };
}

function formatFixBlock(fix: ConcreteFix | SerializableFix, contextLines: number): string {
    const diff = 'diff' in fix && typeof fix.diff === 'string'
        ? fix.diff
        : formatFixWithContext(fix.before, fix.after, contextLines);
    return ['```diff', diff, '```'].join('\n');
}

export function formatNotebookFallback(input: DebugNotebookInput, options?: DebugNotebookOptions): string {
    const maxCards = options?.maxCards ?? DEFAULT_MAX_CARDS;
    const maxFixesPerCard = options?.maxFixesPerCard ?? DEFAULT_MAX_FIXES_PER_CARD;
    const diffContextLines = options?.diffContextLines ?? DEFAULT_DIFF_CONTEXT_LINES;

    const summary = input.summary;
    const lines: string[] = [
        `# ClassMate Debug 错题本`,
        '',
        `- 工作区：${input.workspaceId}`,
        `- 生成时间：${new Date(input.generatedAt).toLocaleString()}`,
        '',
        '## 总体回顾',
        '',
        `- 总事件数：${summary.totalEvents}`,
        `- 编译错误：${summary.errorStats.totalCompileErrors}`,
        `- 编译成功：${summary.errorStats.totalCompileSuccesses}`,
        `- 运行错误：${summary.errorStats.totalRunErrors}`,
        `- 平均修复尝试：${summary.metrics.avgFixAttempts.toFixed(2)}`,
        `- 求助比例：${(summary.metrics.helpSeekingRatio * 100).toFixed(1)}%`,
        `- 独立修复比例：${(summary.metrics.independentFixRatio * 100).toFixed(1)}%`,
        '',
        '## 建议步骤',
        '',
        ...summary.suggestedSteps.map((s) => `- ${s}`),
        '',
    ];

    const cards = input.cards.slice(0, maxCards);
    if (cards.length > 0) {
        lines.push('## 知识点卡片');
        lines.push('');

        for (const card of cards) {
            lines.push(`### ${card.title}`);
            lines.push('');
            lines.push(`**标签：** \`${card.tag}\``);
            lines.push('');
            lines.push(`**摘要：** ${card.summary}`);
            lines.push('');
            lines.push('**常见原因：**');
            for (const cause of card.commonCauses) {
                lines.push(`- ${cause}`);
            }
            lines.push('');
            lines.push('**建议修复：**');
            for (const fix of card.suggestedFixes) {
                lines.push(`- ${fix}`);
            }
            lines.push('');
            lines.push(`**检查方法：** ${card.checkMethod}`);
            lines.push('');
            if (card.phenomenon) {
                lines.push(`**错误现象：** ${card.phenomenon}`);
                lines.push('');
            }
            lines.push(card.phenomenon
                ? '**概念反例（教学示例，不是你的代码）：**'
                : '**错误示例：**');
            lines.push('```cpp');
            lines.push(card.wrongExample);
            lines.push('```');
            lines.push('');
            lines.push(card.phenomenon
                ? '**概念正例（教学示例，不是你的修复）：**'
                : '**正确示例：**');
            lines.push('```cpp');
            lines.push(card.correctExample);
            lines.push('```');

            const fixes = card.concreteFixes.slice(0, maxFixesPerCard);
            if (fixes.length > 0) {
                lines.push('');
                lines.push('**真实修复示例：**');
                for (let i = 0; i < fixes.length; i++) {
                    lines.push('');
                    lines.push(`Fix ${i + 1}:`);
                    lines.push(formatFixBlock(fixes[i], diffContextLines));
                }
            }

            lines.push('');
            lines.push(
                `*出现 ${card.frequency} 次，已解决 ${card.resolvedCount} 次，未解决 ${card.unresolvedCount} 次，平均修复尝试 ${card.avgFixAttempts.toFixed(2)} 次。*`
            );
            lines.push('');
        }
    }

    return lines.join('\n');
}
