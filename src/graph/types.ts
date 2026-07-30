import type { MessageIntent } from '../chat/types';
import type { LLMAttachment, LLMImage } from '../llm/types';
import type {
	LearnerLevel,
	RetrievedSkillSection,
	SkillCandidate,
	SkillPurpose,
} from '../skill/types';
import type {
	LoadedProblemCard,
	LoadedProblemCardFacts,
	ProblemCardCandidate,
	ProblemIdentificationDecision,
	ProblemRecognitionEvidence,
} from '../problemKnowledge/types';
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
export type ContextMode =
	| 'none'
	| 'active_file'
	| 'problem_context'
	| 'debug_context'
	| 'edit_context';

/**
 * Remembers which assignment files were used in the previous turn.
 * This lets short follow-ups such as “那下一步呢” keep using the same problem.
 */
export interface ConversationWorkspaceContext {
	problemRoot?: string;
	questionPath?: string;
	activeSourcePath?: string;
	relatedPaths: string[];
	previousRequestType?: RequestType;
	previousContextMode?: ContextMode;
	isAssignmentWorkspace?: boolean;
	problemCardId?: string;
	problemCardVariantId?: string;
	problemCardConfidence?: number;
	problemFingerprint?: string;
}

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
	contextMode: ContextMode;
	confidence: number;
	isAssignmentWorkspace: boolean;
	assignmentRoot?: string;
	assignmentEvidence: string[];
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
	previousWorkspaceContext?: ConversationWorkspaceContext;
}

export interface ClassMateGraphState {
	request: ClassMateRequest;
	initialRoute?: InitialRoute;
	routeAndPlanResult?: RouteAndPlanResult;
	requestType?: RequestType;
	contextMode?: ContextMode;
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
	routeAndPlanWorkspacePreview: LoadedWorkspaceItem[];
	loadedWorkspaceItems: LoadedWorkspaceItem[];
	workspaceSnapshot?: WorkspaceContextSnapshot;
	conversationWorkspaceContext?: ConversationWorkspaceContext;

	learnerState?: LearnerState;
	answerPlan?: AnswerPlan;
	skillRetrievalQuery?: SkillRetrievalQuery;
	skillCandidates: SkillCandidate[];
	retrievedSkillSections: RetrievedSkillSection[];
	skillRequests: SkillRequest[];
	assembledSkillContext?: string;
	skillGraphVersion?: string;
	retrievalDegraded: boolean;
	problemRecognitionEvidence?: ProblemRecognitionEvidence;
	problemCardCandidates: ProblemCardCandidate[];
	problemIdentification?: ProblemIdentificationDecision;
	loadedProblemCard?: LoadedProblemCard;
	/** 与已匹配题目对应的机器可校验事实；教学说明仍保存在 Markdown 卡片中。 */
	loadedProblemCardFacts?: LoadedProblemCardFacts;
	assembledProblemCardContext?: string;
	problemKnowledgeDegraded: boolean;

	answerMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
	answer?: string;
	answerValidation?: AnswerValidationResult;
	answerRetryCount: number;
	/** 本次请求中已经完成的 LangGraph 节点耗时，按执行顺序排列。 */
	nodeTimings: GraphNodeTiming[];
	error?: string;
}
