import { estimateTokens } from '../workspace/contextPolicy';

/**
 * 模型可见历史的裁剪规则:
 * - UI 历史原样保留,这里只决定"发给模型什么";
 * - 成品引用链接(classmate-ref://)与来源行**无条件**剥成行内代码:历史里
 *   出现这些会让模型模仿着自编裸链接(死链),无论文件是否变化(run3 实证);
 * - 文件 hash 变化后,旧 assistant 消息里的多行代码块与实现状态结论不再是
 *   证据:代码块整体移除(连同其来源行,不留半截 fence),状态声明替换为占位说明;
 * - 文件没变时历史一字不动(除防模仿清洗);
 * - token 预算从最旧整轮开始裁,最新一轮永不裁。
 */
export const MODEL_HISTORY_TOKEN_BUDGET = 8_000;

export interface ModelHistoryInput {
	history: Array<{
		role: 'user' | 'assistant';
		content: string;
		referenceFiles?: string[];
	}>;
	currentFileHashes: Map<string, string>;
	previousFileHashes: Map<string, string>;
	tokenBudget: number;
}

/** 与旧文件版本绑定的实现状态措辞;只匹配"旧轮回答断言代码状态"的形态。 */
const STALE_STATE_PATTERN =
	/(现在是?空的|函数体(里)?只有注释|还没写完|已经写(完|好)了|不需要再改|有\s*\d+\s*行(实际)?代码|只有\s*\d+\s*行|(✅\s*)?(?<![未没])已实现|(已|都)?改好了|(?:⚠️?)?\s*TODO)/;

function basenameOf(file: string): string {
	return file.replace(/\\/g, '/').split('/').pop() ?? file;
}

function comparablePath(value: string): string {
	return value.replace(/\\/g, '/').toLocaleLowerCase();
}

function anyReferencedFileChanged(input: ModelHistoryInput, message: string): boolean {
	// 兜底策略(临时):按"文件名词干出现在整轮文本"猜测归属。
	// 这只在 7.6 引用契约(正文 {{ref:targetId|name}} 标记 → targetId → 文件
	// 的精确绑定)落地前使用;契约接入后应替换为按引用标记逐轮精确判断,
	// 本函数随即退役。
	const mentioned = [...input.previousFileHashes.keys()]
		.filter((file) => message.includes(file.split('/').pop()!.split('.')[0]));
	return mentioned.some((file) =>
		input.currentFileHashes.get(comparablePath(file))
			!== input.previousFileHashes.get(comparablePath(file))
	);
}

const FINISHED_LINK_PATTERN =
	/\[(`[^`]*`|[^[\]]*)\]\(classmate-ref:\/\/\d+(?:\?i)?\)/g;
const SOURCE_LINE_PATTERN = /^\*来源:.*$\n?/gm;
/** refblock 残留(模型写了对齐标记但 finalizer 未接,或历史迁移残留)。 */
const REFBLOCK_REMNANT_PATTERN = /\{\{refblock:[^}\s]*\}\}\n?/g;

/**
 * 防模仿清洗(无条件,所有 assistant 轮):历史里的成品链接/来源行对模型是
 * "可以这么写链接"的示范,run3 实证模型会照抄出指向空清单的死链。
 * 剥成行内代码文字后,教学语义保留、格式示范消失。
 */
function stripContractArtifacts(content: string): string {
	return content
		.replace(REFBLOCK_REMNANT_PATTERN, '')
		.replace(FINISHED_LINK_PATTERN, (_match, label: string) =>
			label.startsWith('`') ? label : `\`${label}\``)
		.replace(SOURCE_LINE_PATTERN, '')
		.replace(/\n{3,}/g, '\n\n');
}

function stripStaleCodeBlocks(content: string): string {
	// 整块移除 fenced code block(含紧随其后的来源行);块外文字保留。
	return content
		.replace(/```[\s\S]*?```(\n\*来源:[^\n]*\n?)?/g, '')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

function replaceStaleStateClaims(content: string): string {
	// 按句替换状态声明,保留教学性文字。
	return content
		.split('\n')
		.map((line) =>
			STALE_STATE_PATTERN.test(line)
				? '[此前讨论的代码状态基于旧版本,当前以最新冻结工作区为准]'
				: line
		)
		.join('\n');
}

export function buildModelVisibleHistory(input: ModelHistoryInput): Array<{
	role: 'user' | 'assistant';
	content: string;
}> {
	const workspaceChanged = [...input.previousFileHashes.keys()].some((file) =>
		input.currentFileHashes.get(comparablePath(file))
			!== input.previousFileHashes.get(comparablePath(file))
	);
	// 文件归属按"整轮"判断:学生消息点名文件、回答只谈函数是最常见形态,
	// 只看 assistant 消息会漏掉绝大多数需要清洗的轮次。
	const turnScope = (index: number): string => {
		const start = index - (index % 2 === 0 ? 0 : 1);
		return input.history
			.slice(start, start + 2)
			.map((message) => message.content)
			.join('\n');
	};
	// 精确绑定(优先):引用契约下 assistant 轮带 referenceFiles(实际链接的
	// 文件)。这些文件中任一 hash 变化 → 该轮按旧版本清洗。
	const turnReferences = (index: number): string[] | undefined =>
		input.history[index - (index % 2 === 0 ? 0 : 1) + 1]?.referenceFiles;
	const cleaned = input.history.map((message, index) => {
		if (message.role !== 'assistant') {
			return message;
		}
		// 防模仿清洗无条件执行(与文件变化无关)。
		if (!workspaceChanged) {
			const sanitized = stripContractArtifacts(message.content);
			return sanitized === message.content ? message : { ...message, content: sanitized };
		}
		// 精确绑定:referenceFiles 里任一文件 hash 变化才清洗。
		const preciseFiles = turnReferences(index);
		if (preciseFiles !== undefined) {
			const changed = preciseFiles.some((file) =>
				input.currentFileHashes.get(comparablePath(basenameOf(file)))
					!== input.previousFileHashes.get(comparablePath(basenameOf(file)))
			);
			if (!changed) {
				return message;
			}
		} else if (!anyReferencedFileChanged(input, turnScope(index))) {
			// 兜底(7.6 后仅在旧会话无引用元数据时走到)。
			return message;
		}
		const withoutCode = stripStaleCodeBlocks(message.content);
		return {
			...message,
			content: replaceStaleStateClaims(stripContractArtifacts(withoutCode)),
		};
	});

	// token 预算:按整轮(user+assistant 对)从最旧开始裁。
	const pairs: Array<Array<{ role: 'user' | 'assistant'; content: string }>> = [];
	for (let index = 0; index < cleaned.length; index += 2) {
		const pair = cleaned.slice(index, index + 2);
		if (pair[0]?.role === 'assistant') {
			// 悬空 assistant(理论上不该有):并入上一轮。
			pairs[pairs.length - 1]?.push(...pair);
			continue;
		}
		pairs.push(pair);
	}
	let total = cleaned.reduce((sum, message) => sum + estimateTokens(message.content), 0);
	let startIndex = 0;
	while (
		pairs.length - startIndex > 1
		&& total > input.tokenBudget
	) {
		const removed = pairs[startIndex]
			.reduce((sum, message) => sum + estimateTokens(message.content), 0);
		total -= removed;
		startIndex++;
	}
	return pairs.slice(startIndex).flat();
}
