import type { MessageIntent } from '../chat/types';
import type {
	InitialRoute,
	LockPolicy,
	RequestSource,
	RequestType,
} from '../graph/types';
import { getTaskByButtonId, getTaskDefinition } from '../graph/taskRegistry';

export type { RequestType } from '../graph/types';

export interface PreclassifyOptions {
	source?: RequestSource;
	buttonId?: string;
}

/**
 * Combines the frontend-declared intent with lightweight text analysis to
 * decide which request type (and therefore which skill references) to use.
 *
 * Frontend intent is trusted when explicit; otherwise we fall back to keyword
 * heuristics on the user text.
 */
export function classifyRequest(
	frontendIntent: MessageIntent | undefined,
	userText: string
): RequestType {
	return preclassifyRequest(frontendIntent, userText).requestType;
}

export function preclassifyRequest(
	frontendIntent: MessageIntent | undefined,
	userText: string,
	options: PreclassifyOptions = {}
): InitialRoute {
	const text = userText.toLowerCase();
	const source = options.source ?? 'conversation';

	if (options.buttonId) {
		const buttonTask = getTaskByButtonId(options.buttonId);
		if (!buttonTask) {
			return {
				requestType: 'unclassified',
				confidence: 0,
				source: 'button',
				lockPolicy: 'fully-locked',
				reason: `Unknown button id: ${options.buttonId}`,
			};
		}
		return {
			requestType: buttonTask.requestType,
			confidence: 1,
			source: 'button',
			lockPolicy: buttonTask.lockPolicy,
			reason: `Mapped from button id: ${options.buttonId}`,
		};
	}

	// If the frontend explicitly chose a non-chat intent, treat it as authoritative
	// but still allow the text analysis to refine the subtype.
	if (frontendIntent && frontendIntent !== 'chat') {
		let requestType: RequestType;
		switch (frontendIntent) {
			case 'hint':
				requestType = 'problem_hint';
				break;
			case 'code_explanation':
				requestType = 'code_explanation';
				break;
			case 'concept_explanation':
				requestType = 'concept_explanation';
				break;
			case 'error_explanation':
				requestType = inferErrorType(text);
				break;
			case 'debug_suggestion':
				requestType = inferDebugType(text);
				break;
			case 'summary':
				requestType = 'mistake_summary';
				break;
			case 'code_edit':
				requestType = 'code_edit';
				break;
			default:
				requestType = 'chat';
				break;
		}
		return {
			requestType,
			confidence: 0.98,
			source,
			lockPolicy: getTaskDefinition(requestType).lockPolicy,
			reason: `Mapped from frontend intent: ${frontendIntent}`,
		};
	}

	// No explicit frontend intent: infer from the text itself.
	if (looksLikeExplicitHintRequest(text)) {
		return {
			requestType: 'problem_hint',
			confidence: 0.98,
			source,
			lockPolicy: 'family-locked',
			reason: 'The user explicitly requested a hint instead of a direct solution.',
		};
	}
	const requestType = inferFromText(text);
	return {
		requestType,
		confidence: requestType === 'chat' ? 0.55 : 0.75,
		source,
		lockPolicy: 'unlocked',
		reason: requestType === 'chat'
			? 'No stronger local classification signal was found.'
			: `Matched local text heuristics for ${requestType}.`,
	};
}

function looksLikeExplicitHintRequest(text: string): boolean {
	return (
		text.includes('提示') ||
		text.includes('第一层') ||
		text.includes('第1层') ||
		text.includes('不要直接告诉') ||
		text.includes('不要直接给') ||
		/\b(hint|clue)\b/i.test(text)
	);
}

function inferFromText(text: string): RequestType {
	if (looksLikeCodeEdit(text)) {
		return 'code_edit';
	}
	if (looksLikeError(text)) {
		return inferErrorType(text);
	}

	if (looksLikeRuntimeError(text)) {
		return 'runtime_error_help';
	}

	if (looksLikeWrongOutput(text)) {
		return 'wrong_output_help';
	}

	if (looksLikeOjFailure(text)) {
		return 'oj_failure_help';
	}

	if (looksLikeConceptQuestion(text)) {
		return 'concept_explanation';
	}

	if (looksLikeCodeExplanation(text)) {
		return 'code_explanation';
	}

	if (looksLikeNoIdea(text)) {
		return 'problem_hint';
	}

	if (looksLikeProblemUnderstanding(text)) {
		return 'problem_understanding';
	}

	if (looksLikeOopConfusion(text)) {
		return 'oop_confusion';
	}

	if (looksLikeSolutionRequest(text)) {
		return 'solution_request';
	}

	return 'chat';
}

function looksLikeCodeEdit(text: string): boolean {
	return (
		text.includes('修改代码') ||
		text.includes('帮我修改') ||
		text.includes('修复代码') ||
		text.includes('替换代码') ||
		/\b(edit|modify|refactor|fix the code)\b/i.test(text)
	);
}

function inferErrorType(text: string): RequestType {
	if (
		text.includes('runtime error') ||
		text.includes('segmentation fault') ||
		text.includes('segfault') ||
		text.includes('signal') ||
		text.includes('abort') ||
		text.includes('exception')
	) {
		return 'runtime_error_help';
	}
	if (
		text.includes('undefined reference') ||
		text.includes('linker') ||
		text.includes('ld:') ||
		text.includes('unresolved external')
	) {
		return 'compile_error_help';
	}
	return 'compile_error_help';
}

function inferDebugType(text: string): RequestType {
	if (looksLikeError(text)) {
		return inferErrorType(text);
	}
	if (looksLikeWrongOutput(text)) {
		return 'wrong_output_help';
	}
	return 'runtime_error_help';
}

function looksLikeError(text: string): boolean {
	return (
		text.includes('error:') ||
		text.includes('编译错误') ||
		text.includes('编译报错') ||
		text.includes('编译不过') ||
		text.includes('编译失败') ||
		text.includes('报错') ||
		text.includes('expected') ||
		text.includes('undeclared') ||
		text.includes('undefined reference') ||
		text.includes('cannot find') ||
		text.includes('no matching function') ||
		text.includes('invalid')
	);
}

function looksLikeRuntimeError(text: string): boolean {
	return (
		text.includes('运行时错误') ||
		text.includes('运行错误') ||
		text.includes('崩溃') ||
		text.includes('闪退') ||
		text.includes('segmentation fault') ||
		text.includes('segfault') ||
		text.includes('signal') ||
		text.includes('exception') ||
		text.includes('abort')
	);
}

function looksLikeWrongOutput(text: string): boolean {
	return (
		text.includes('输出不对') ||
		text.includes('输出错误') ||
		text.includes('结果不对') ||
		text.includes('答案错误') ||
		text.includes('wrong output') ||
		text.includes('output wrong')
	);
}

function looksLikeOjFailure(text: string): boolean {
	return (
		text.includes('oj') ||
		text.includes('online judge') ||
		text.includes('样例通过') ||
		text.includes('本地通过') ||
		text.includes('提交失败') ||
		text.includes('tle') ||
		text.includes('time limit') ||
		text.includes('mle') ||
		text.includes('memory limit')
	);
}

function looksLikeConceptQuestion(text: string): boolean {
	return (
		text.includes('什么是') ||
		text.includes('什么叫') ||
		text.includes('解释一下') ||
		text.includes('什么是') ||
		text.includes('给我讲讲') ||
		text.includes('讲讲') ||
		text.includes('介绍一下') ||
		text.includes('概念')
	);
}

function looksLikeCodeExplanation(text: string): boolean {
	return (
		text.includes('这段代码') ||
		text.includes('这行代码') ||
		text.includes('这个函数') ||
		text.includes('这段程序') ||
		text.includes('explain this code') ||
		text.includes('what does this code')
	);
}

function looksLikeNoIdea(text: string): boolean {
	return (
		text.includes('没思路') ||
		text.includes('不会写') ||
		text.includes('不知道') ||
		text.includes('怎么做') ||
		text.includes('怎么办') ||
		text.includes('从哪开始') ||
		text.includes('完全没有')
	);
}

function looksLikeProblemUnderstanding(text: string): boolean {
	return (
		text.includes('题意') ||
		text.includes('题目') ||
		text.includes('输入') ||
		text.includes('输出') ||
		text.includes('约束') ||
		text.includes('条件') ||
		text.includes('看不懂')
	);
}

function looksLikeOopConfusion(text: string): boolean {
	return (
		text.includes('类') ||
		text.includes('对象') ||
		text.includes('继承') ||
		text.includes('多态') ||
		text.includes('封装') ||
		text.includes('构造函数') ||
		text.includes('运算符重载')
	);
}

function looksLikeSolutionRequest(text: string): boolean {
	return (
		text.includes('完整代码') ||
		text.includes('完整答案') ||
		text.includes('全部代码') ||
		text.includes('给我代码') ||
		text.includes('solution') ||
		text.includes('完整实现')
	);
}
