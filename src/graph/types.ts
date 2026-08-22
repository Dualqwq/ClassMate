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
import type { WorkspaceChange, WorkspaceVersionIndex } from '../workspace/workspaceVersionIndex';

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
	/** 本轮实际加载文件的内容 hash;供下一轮裁剪模型可见历史。 */
	fileHashes?: Record<string, string>;
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

export type GraphNodeTrace =
	| (GraphNodeTiming & {
		status: 'completed';
		inputState: ClassMateGraphState;
		state: ClassMateGraphState;
	})
	| (GraphNodeTiming & {
		status: 'failed';
		inputState: ClassMateGraphState;
		state: ClassMateGraphState;
		error: { name: string; message: string; stack?: string };
	});

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

export type AnswerOutcome =
	| 'answered'
	| 'grounded_local_hint'
	| 'recovery_fallback'
	| 'generic_fallback';

/**
 * 从已加载题面和代码中提取出的短约束表。
 * 它只保存回答正确性真正需要的事实，不复制整个工作区正文。
 */
export interface ProblemConstraints {
	hardConstraints: string[];
	requiredOperations: string[];
	inputLimits: string[];
	expectedBehaviors: string[];
	uncertainItems: string[];
	evidencePaths: string[];
}

export type CorrectnessIssueCategory =
	| 'constraint_ignored'
	| 'wrong_algorithm'
	| 'invalid_example'
	| 'arithmetic_inconsistency'
	| 'unsupported_claim'
	| 'invented_interface'
	| 'code_answer_mismatch'
	| 'incomplete_solution'
	| 'other';

export interface CorrectnessIssue {
	category: CorrectnessIssueCategory;
	description: string;
	correction: string;
}

/** 轻量检查器对候选回答的结构化判定。 */
export interface CorrectnessVerification {
	checked: boolean;
	passed: boolean;
	severity: 'none' | 'minor' | 'major';
	issues: CorrectnessIssue[];
	correctedAnswer?: string;
	degraded?: boolean;
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
		/** 引用契约:该轮回答实际链接的文件(精确历史裁剪用)。 */
		referenceFiles?: string[];
		/** 7.8:该轮回答依据的冻结快照 hash(逐轮精确绑定)。 */
		basisFileHashes?: Record<string, string>;
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
	/** 冻结时的整个可加载工作区版本;回答交付前用它复核是否漂移。 */
	workspaceVersionIndex?: WorkspaceVersionIndex;
	/** 交付前复核发现的工作区漂移(创建/修改/删除/重命名)。 */
	workspaceDriftChanges?: WorkspaceChange[];
	/** 引用契约:冻结工作区的 C++ 符号索引(候选引用目标)。 */
	workspaceSymbols?: import('../parser/cppWorkspaceIndex').CppWorkspaceIndex;
	/** 因工作区漂移已经重建上下文并重生成的次数。 */
	workspaceDriftRetryCount: number;
	/** 7.8 恢复通道:缺证据补读已完成的轮数(上限 2)。 */
	evidenceBackfillCount: number;
	/**
	 * 补读刚完成、下一步应回 freeze_context 重建快照的瞬时标记
	 * (由 load_evidence_backfill 设置,freeze_context 消费清除)。
	 */
	evidenceBackfillPending?: ContextRequest[];
	/** 7.7 结构事实核对:冲突时重生成一次的计数。 */
	groundingRetryCount: number;
	/** 7.8 恢复通道:answer 节点模型调用失败(非取消)已发生的次数。 */
	modelFailureCount: number;
	/**
	 * 模型调用失败待重试的瞬时标记(answer 条件边据此路由回自身,
	 * 重试成功或转入兜底时清除)。
	 */
	recoveryAttempt?: { stage: string; message: string };
	/** 重生成时随 answer 提示下发的本地事实纠正指令(瞬时,由 _answer 消费)。 */
	groundingCorrectionInstruction?: string;
	/** grounding_check 的核对结果(证词:定位到的声明与冲突)。 */
	groundingCheck?: {
		claims: Array<{
			kind: string;
			targetId: string;
			symbolName: string;
			statedFact: string;
			actualFact: string;
			sentence: string;
			statedCount?: number;
		}>;
		conflicts: Array<unknown>;
		passed: boolean;
	};
	/** verify_workspace 本步刚完成重载、下一步应重建回答的瞬时标记。 */
	workspaceDriftRegenerate: boolean;
	conversationWorkspaceContext?: ConversationWorkspaceContext;
	problemConstraints?: ProblemConstraints;
	constraintExtractionDegraded: boolean;
	correctnessCheckRequired: boolean;
	correctnessVerification?: CorrectnessVerification;
	answerDelivered: boolean;

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

	/** 课件 GraphRAG 检索出的相关片段，拼入 answer prompt。 */
	assembledCoursewareContext?: string;

	answerMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
	answer?: string;
	/** 引用契约生成的最终引用清单(由正文标记确定)。 */
	answerReferences?: import('../chat/types').ChatReference[];
	/** 程序侧块来源自查(证词数据,不渲染):每个栅栏代码块的确定性溯源结果。 */
	answerBlockSources?: Array<{
		blockIndex: number;
		status: 'unique' | 'unique-file' | 'ambiguous' | 'none';
		file?: string;
		targetId?: string;
	}>;
	answerOutcome?: AnswerOutcome;
	answerValidation?: AnswerValidationResult;
	answerRetryCount: number;
	/** 本次请求中已经完成的 LangGraph 节点耗时，按执行顺序排列。 */
	nodeTimings: GraphNodeTiming[];
	error?: string;
}
