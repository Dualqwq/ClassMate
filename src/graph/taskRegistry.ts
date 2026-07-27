import type {
	ActionType,
	AnswerPlan,
	LockPolicy,
	RequestType,
} from './types';
import type { SkillPurpose } from '../skill/types';

export interface TaskDefinition {
	requestType: RequestType;
	actionType: ActionType;
	lockPolicy: LockPolicy;
	buttonIds: string[];
	defaultPurposes: SkillPurpose[];
	defaultResponsePattern: string[];
}
const taskDefinitions: TaskDefinition[] = [
	{
		requestType: 'chat',
		actionType: 'answer',
		lockPolicy: 'unlocked',
		buttonIds: [],
		defaultPurposes: [],
		defaultResponsePattern: ['直接回应用户当前问题'],
	},
	{
		requestType: 'problem_understanding',
		actionType: 'answer',
		lockPolicy: 'unlocked',
		buttonIds: [],
		defaultPurposes: ['definition', 'example'],
		defaultResponsePattern: ['说明题目目标', '解释输入输出', '指出开始步骤'],
	},
	{
		requestType: 'problem_hint',
		actionType: 'answer',
		lockPolicy: 'family-locked',
		buttonIds: ['hint'],
		defaultPurposes: ['prerequisite', 'example'],
		defaultResponsePattern: ['给出当前提示层级对应的下一步'],
	},
	{
		requestType: 'concept_explanation',
		actionType: 'answer',
		lockPolicy: 'family-locked',
		buttonIds: ['concept_explanation'],
		defaultPurposes: ['definition', 'example', 'misconception'],
		defaultResponsePattern: ['简短定义', '说明用途', '给出小例子', '指出常见误区'],
	},
	{
		requestType: 'code_explanation',
		actionType: 'answer',
		lockPolicy: 'family-locked',
		buttonIds: ['code_explanation', 'classmate.explainSelection'],
		defaultPurposes: ['definition', 'example'],
		defaultResponsePattern: ['说明整体作用', '解释关键代码块', '说明关键变量变化'],
	},
	{
		requestType: 'compile_error_help',
		actionType: 'answer',
		lockPolicy: 'family-locked',
		buttonIds: ['error_explanation', 'classmate.explainError'],
		defaultPurposes: ['debug', 'misconception'],
		defaultResponsePattern: ['翻译错误', '指出位置', '解释原因', '给出最小修复'],
	},
	{
		requestType: 'runtime_error_help',
		actionType: 'answer',
		lockPolicy: 'family-locked',
		buttonIds: ['debug_suggestion'],
		defaultPurposes: ['debug', 'misconception'],
		defaultResponsePattern: ['描述运行现象', '定位原因', '给出最小修复', '建议验证方法'],
	},
	{
		requestType: 'wrong_output_help',
		actionType: 'answer',
		lockPolicy: 'unlocked',
		buttonIds: [],
		defaultPurposes: ['debug', 'example'],
		defaultResponsePattern: ['比较预期与实际输出', '检查分支循环和状态更新', '给出验证用例'],
	},
	{
		requestType: 'oj_failure_help',
		actionType: 'answer',
		lockPolicy: 'unlocked',
		buttonIds: [],
		defaultPurposes: ['debug', 'misconception'],
		defaultResponsePattern: ['检查边界和多测', '检查格式与溢出', '设计小测试'],
	},
	{
		requestType: 'oop_confusion',
		actionType: 'answer',
		lockPolicy: 'unlocked',
		buttonIds: [],
		defaultPurposes: ['definition', 'example', 'misconception'],
		defaultResponsePattern: ['区分相关概念', '给出小型类示例', '指出常见误区'],
	},
	{
		requestType: 'mistake_summary',
		actionType: 'answer',
		lockPolicy: 'family-locked',
		buttonIds: ['summary'],
		defaultPurposes: ['response_pattern'],
		defaultResponsePattern: ['按照错题总结结构输出 Markdown'],
	},
	{
		requestType: 'solution_request',
		actionType: 'answer',
		lockPolicy: 'unlocked',
		buttonIds: [],
		defaultPurposes: ['example', 'prerequisite'],
		defaultResponsePattern: ['给出完整方案', '解释关键代码'],
	},
	{
		requestType: 'code_edit',
		actionType: 'edit',
		lockPolicy: 'family-locked',
		buttonIds: ['code_edit'],
		defaultPurposes: ['debug'],
		defaultResponsePattern: ['简要说明修改', '输出完整替换内容'],
	},
	{
		requestType: 'unclassified',
		actionType: 'ask_user',
		lockPolicy: 'unlocked',
		buttonIds: [],
		defaultPurposes: [],
		defaultResponsePattern: ['询问一个能够确定用户目标的问题'],
	},
];

export const TASK_REGISTRY: ReadonlyMap<RequestType, TaskDefinition> = new Map(
	taskDefinitions.map((definition) => [definition.requestType, definition])
);

const BUTTON_TASK_INDEX: ReadonlyMap<string, TaskDefinition> = new Map(
	taskDefinitions.flatMap((definition) =>
		definition.buttonIds.map((buttonId) => [buttonId, definition] as const)
	)
);

export function getTaskDefinition(requestType: RequestType): TaskDefinition {
	return TASK_REGISTRY.get(requestType) ?? TASK_REGISTRY.get('unclassified')!;
}

export function getTaskByButtonId(buttonId: string): TaskDefinition | undefined {
	return BUTTON_TASK_INDEX.get(buttonId);
}

export function buildDefaultAnswerPlan(
	requestType: RequestType,
	concepts: string[],
	hintLevel: 1 | 2 | 3 | 4 = 1
): AnswerPlan {
	const definition = getTaskDefinition(requestType);
	const allowCompleteCode = requestType === 'solution_request' || requestType === 'code_edit';
	return {
		requestType,
		depthLevel: allowCompleteCode ? 4 : hintLevel,
		responsePattern: definition.defaultResponsePattern,
		mustInclude: requestType === 'compile_error_help' || requestType === 'runtime_error_help'
			? ['指出最可能的位置和原因', '优先给出最小修复']
			: [],
		mustAvoid: allowCompleteCode ? [] : ['没有明确请求时不要直接给出完整答案'],
		allowCompleteCode,
		skillQuery: {
			requestType,
			concepts,
			purposes: definition.defaultPurposes,
			learnerLevel: 'beginner',
			hintLevel,
			maxSections: 3,
			maxTokens: 1800,
		},
	};
}
