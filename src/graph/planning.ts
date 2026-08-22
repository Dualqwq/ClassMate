import type {
	AnswerPlan,
	AnswerValidationResult,
	LearnerState,
	PlannerResult,
	RequestType,
} from './types';
import { buildDefaultAnswerPlan } from './taskRegistry';

const CONCEPT_PATTERNS: Array<[string, RegExp]> = [
	['指针', /指针|pointer|\*+\s*[a-zA-Z_]|nullptr|null\b/i],
	['数组', /数组|array|\[[^\]]*\]/i],
	['函数参数', /参数|形参|实参|parameter|argument/i],
	['递归', /递归|recursion|recursive/i],
	['vector', /\bvector\b|向量容器/i],
	['类与对象', /类|对象|class\b|object\b/i],
	['构造函数', /构造函数|constructor/i],
	['继承', /继承|inherit/i],
	['多态', /多态|polymorph|virtual\b/i],
	['栈与堆', /栈|堆|stack\b|heap\b/i],
	['链表', /链表|linked\s*list|next\s*指针|push_front|push_back|insert_after|remove_first/i],
	['析构与内存释放', /析构|内存泄漏|释放内存|delete\b|destructor|memory\s*leak/i],
	['深拷贝', /深拷贝|浅拷贝|拷贝构造|赋值运算符|copy\s*constructor|operator\s*=/i],
];

export function inferConcepts(...texts: Array<string | undefined>): string[] {
	const joined = texts.filter(Boolean).join('\n');
	return CONCEPT_PATTERNS
		.filter(([, pattern]) => pattern.test(joined))
		.map(([concept]) => concept)
		.slice(0, 8);
}

export function buildLearnerState(
	userText: string,
	history: Array<{ role: 'user' | 'assistant'; content: string }>
): LearnerState {
	const recent = history.slice(-8);
	const previousHints = recent.filter((message) =>
		message.role === 'assistant' && /提示|下一步|先想/i.test(message.content)
	).length;
	const hasAttempted = /```|报错|错误|输出|我的代码|我写|运行|编译/i.test(userText);
	const wantsCompleteSolution = /完整答案|完整代码|直接.*答案|帮我写完|给出解法|solution/i.test(userText);
	const hintLevel = Math.min(4, Math.max(1, previousHints + 1)) as 1 | 2 | 3 | 4;
	return {
		level: 'beginner',
		hasAttempted,
		hintLevel,
		detectedMisconceptions: [],
		wantsCompleteSolution,
	};
}

export function fallbackPlan(
	requestType: RequestType,
	concepts: string[],
	learnerState: LearnerState
): PlannerResult {
	const plan = buildDefaultAnswerPlan(requestType, concepts, learnerState.hintLevel);
	if (requestType === 'code_edit') {
		// code_edit is the only path that may emit a complete replacement block.
	} else {
		plan.allowCompleteCode = false;
		plan.depthLevel = Math.min(plan.depthLevel, learnerState.hintLevel) as 1 | 2 | 3 | 4;
	}
	if (requestType === 'solution_request') {
		const noCompleteCode = '不要直接给出完整代码或完整程序';
		if (!plan.mustAvoid.includes(noCompleteCode)) {
			plan.mustAvoid = [...plan.mustAvoid, noCompleteCode];
		}
	}
	return { answerPlan: plan, skillRetrievalQuery: plan.skillQuery };
}

export function sanitizePlannerResult(
	result: PlannerResult,
	frozenRequestType: RequestType,
	learnerState: LearnerState
): PlannerResult {
	const query = {
		...result.skillRetrievalQuery,
		requestType: frozenRequestType,
		learnerLevel: learnerState.level,
		hintLevel: learnerState.hintLevel,
		maxSections: Math.min(5, Math.max(1, result.skillRetrievalQuery.maxSections)),
		maxTokens: Math.min(4000, Math.max(200, result.skillRetrievalQuery.maxTokens)),
	};
	// #30: solution_request must not become a backdoor for full-code answers.
	const mayReturnCompleteCode = frozenRequestType === 'code_edit';
	const depthLevel = frozenRequestType === 'problem_hint'
		? Math.min(result.answerPlan.depthLevel, learnerState.hintLevel) as 1 | 2 | 3 | 4
		: result.answerPlan.depthLevel;
	const answerPlan: AnswerPlan = {
		...result.answerPlan,
		requestType: frozenRequestType,
		depthLevel,
		allowCompleteCode: mayReturnCompleteCode && result.answerPlan.allowCompleteCode,
		skillQuery: query,
	};
	if (frozenRequestType === 'solution_request' && !answerPlan.allowCompleteCode) {
		const noCompleteCode = '不要直接给出完整代码或完整程序';
		if (!answerPlan.mustAvoid.includes(noCompleteCode)) {
			answerPlan.mustAvoid = [...answerPlan.mustAvoid, noCompleteCode];
		}
	}
	return { answerPlan, skillRetrievalQuery: query };
}

/** 未转换的引用标记形态(含笛号/冒号变体):finalizer 未识别的标记不得直达学生。 */
const UNCONVERTED_MARKER_PATTERN = /\{\{ref(?:[:|])/;

/**
 * correctness_check 修正版的采用校验(7.9 取证 run13):
 * 检查器拒绝候选回答后给出的 correctedAnswer 常是"口头讲清要求/方向"
 * (多文件要点、纯文字指导),code_edit 的"恰好一个完整替换块"格式规则
 * 对它是错配——同一份文字若由 answer 节点产出只会触发重生成而非否决。
 * 这里只做结构底线检查:非空、不泄内部标签、不越提示层级(代码量)。
 */
export function validateCorrectedAnswer(
	answer: string,
	plan: AnswerPlan
): AnswerValidationResult {
	const problems: string[] = [];
	const trimmed = answer.trim();
	if (!trimmed) {
		problems.push('修正版回答为空。');
	}
	if (/<skill_section|Frozen workspace data|ClassMate Answer Mode/i.test(trimmed)
		|| UNCONVERTED_MARKER_PATTERN.test(trimmed)) {
		problems.push('修正版回答泄露了内部提示词或检索标签。');
	}
	const codeBlocks = [...trimmed.matchAll(/```[\s\S]*?```/g)].map((match) => match[0]);
	const codeLines = codeBlocks.reduce(
		(total, block) => total + block.split('\n').filter((line) => line.trim()).length,
		0
	);
	if (!plan.allowCompleteCode && codeLines > 30) {
		problems.push('修正版代码量超出当前层级允许的范围。');
	}
	return {
		valid: problems.length === 0,
		problems,
		shouldRegenerate: false,
	};
}

export function validateStudentAnswer(answer: string, plan: AnswerPlan): AnswerValidationResult {	const problems: string[] = [];
	const trimmed = answer.trim();
	if (!trimmed) {
		problems.push('回答为空。');
	}
	if (/<skill_section|Frozen workspace data|ClassMate Answer Mode/i.test(trimmed)
		|| UNCONVERTED_MARKER_PATTERN.test(trimmed)) {
		problems.push('回答泄露了内部提示词或检索标签。');
	}
	const codeBlocks = [...trimmed.matchAll(/```[\s\S]*?```/g)].map((match) => match[0]);
	const codeLines = codeBlocks.reduce(
		(total, block) => total + block.split('\n').filter((line) => line.trim()).length,
		0
	);
	if (!plan.allowCompleteCode && codeLines > 18) {
		problems.push('当前层级不允许直接给出大段完整代码。');
	}
	// #30: solution_request is a teaching hint route, not a license to write the full program.
	if (plan.requestType === 'solution_request' && codeLines > 18) {
		problems.push('solution_request 不允许直接给出完整代码或完整程序，请改为提示和引导。');
	}
	if (plan.requestType === 'problem_hint' && plan.depthLevel === 1) {
		if (trimmed.length > 900) {
			problems.push('第一层提示过长，应只保留一个关键线索和一个引导问题。');
		}
		if (codeLines > 8) {
			problems.push('第一层提示不应包含大段代码。');
		}
	}
	if (plan.requestType === 'code_edit') {
		if (codeBlocks.length !== 1) {
			problems.push('代码修改回答必须恰好包含一个完整代码块。');
		}
		if (/省略|其余不变|\.\.\./i.test(codeBlocks[0] ?? '')) {
			problems.push('完整替换代码中不能包含省略内容。');
		}
	}
	return {
		valid: problems.length === 0,
		problems,
		shouldRegenerate: problems.length > 0,
	};
}
