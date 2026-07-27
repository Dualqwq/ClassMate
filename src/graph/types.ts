import type { MessageIntent } from '../chat/types';
import type { LLMAttachment, LLMImage } from '../llm/types';
import type {
	LearnerLevel,
	RetrievedSkillSection,
	SkillCandidate,
	SkillPurpose,
} from '../skill/types';
import type {
	LoadedWorkspaceItem,
	MinimalWorkspaceContext,
	WorkspaceContextSnapshot,
} from '../workspace/types';

export type RequestType =
	| 'chat'
	| 'problem_understanding'
	| 'problem_hint'
	| 'concept_explanation'
	| 'code_explanation'
	| 'compile_error_help'
	| 'runtime_error_help'
	| 'wrong_output_help'
	| 'oj_failure_help'
	| 'oop_confusion'
	| 'mistake_summary'
	| 'solution_request'
	| 'code_edit'
	| 'unclassified';

export type ActionType = 'answer' | 'compile' | 'run' | 'edit' | 'ask_user' | 'stop';
export type LockPolicy = 'unlocked' | 'family-locked' | 'fully-locked';
export type RequestSource = 'conversation' | 'button';
export type GraphMode = 'route_and_plan' | 'answer';

export interface GraphNodeTiming {
	node: string;
	sequence: number;
	startedAt: number;
	durationMs: number;
}

export interface InitialRoute {
	requestType: RequestType;
	confidence: number;
	source: RequestSource;
	lockPolicy: LockPolicy;
	reason: string;
}

export interface ContextRequest {
	source: 'workspace' | 'skill' | 'user';
	target: string;
	section?: string;
	required: boolean;
	reason: string;
}

export interface RouterResult {
	requestType: RequestType;
	confidence: number;
	alternativeRequestTypes: RequestType[];
	contextRequests: ContextRequest[];
	reason: string;
}

export interface LearnerState {
	level: LearnerLevel;
	hasAttempted: boolean;
	hintLevel: 1 | 2 | 3 | 4;
	detectedMisconceptions: string[];
	currentBlocker?: string;
	wantsCompleteSolution: boolean;
}

export interface SkillRetrievalQuery {
	requestType: RequestType;
	concepts: string[];
	purposes: SkillPurpose[];
	learnerLevel: LearnerLevel;
	hintLevel: 1 | 2 | 3 | 4;
	maxSections: number;
	maxTokens: number;
}

export interface AnswerPlan {
	requestType: RequestType;
	depthLevel: 1 | 2 | 3 | 4;
	responsePattern: string[];
	mustInclude: string[];
	mustAvoid: string[];
	allowCompleteCode: boolean;
	skillQuery: SkillRetrievalQuery;
}

export interface PlannerResult {
	answerPlan: AnswerPlan;
	skillRetrievalQuery: SkillRetrievalQuery;
}

export interface SkillRequest {
	id: string;
	required: boolean;
	reason: string;
}

export interface RouteAndPlanResult {
	requestType: RequestType;
	confidence: number;
	workspaceRequests: ContextRequest[];
	skillRequests: SkillRequest[];
	answerPlan: AnswerPlan;
	skillRetrievalQuery: SkillRetrievalQuery;
	reason: string;
}

export interface AnswerValidationResult {
	valid: boolean;
	problems: string[];
	shouldRegenerate: boolean;
}

export interface ClassMateRequest {
	requestId: string;
	conversationId: string;
	userText: string;
	frontendIntent?: MessageIntent;
	requestSource: RequestSource;
	buttonId?: string;
	conversationHistory: Array<{
		role: 'user' | 'assistant';
		content: string;
		images?: LLMImage[];
		attachments?: LLMAttachment[];
	}>;
}

export interface ClassMateGraphState {
	request: ClassMateRequest;
	initialRoute?: InitialRoute;
	routeAndPlanResult?: RouteAndPlanResult;
	requestType?: RequestType;
	actionType?: ActionType;
	requestTypeFrozen: boolean;
	answerContextFrozen: boolean;
	routeAndPlanAttemptCount: number;
	/**
	 * 路由器已经处理过的上下文请求。
	 * 用它避免模型反复索取同一个文件或同一个 skill 小节，造成无意义的 API 循环。
	 */
	processedContextRequestKeys: string[];

	minimalWorkspaceContext?: MinimalWorkspaceContext;
	loadedWorkspaceItems: LoadedWorkspaceItem[];
	workspaceSnapshot?: WorkspaceContextSnapshot;

	learnerState?: LearnerState;
	answerPlan?: AnswerPlan;
	skillRetrievalQuery?: SkillRetrievalQuery;
	skillCandidates: SkillCandidate[];
	retrievedSkillSections: RetrievedSkillSection[];
	skillRequests: SkillRequest[];
	assembledSkillContext?: string;
	skillGraphVersion?: string;
	retrievalDegraded: boolean;

	answerMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
	answer?: string;
	answerValidation?: AnswerValidationResult;
	answerRetryCount: number;
	/** 本次请求中已经完成的 LangGraph 节点耗时，按执行顺序排列。 */
	nodeTimings: GraphNodeTiming[];
	error?: string;
}
