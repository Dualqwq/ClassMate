import * as path from 'path';
import type {
	ContextMode,
	ContextRequest,
	ConversationWorkspaceContext,
	RequestType,
} from '../graph/types';
import type {
	MinimalWorkspaceContext,
	WorkspaceFileEntry,
	WorkspaceFileKind,
} from './types';

const PROBLEM_TYPES = new Set<RequestType>([
	'problem_understanding',
	'problem_hint',
	'solution_request',
]);

const DEBUG_TYPES = new Set<RequestType>([
	'compile_error_help',
	'runtime_error_help',
	'wrong_output_help',
	'oj_failure_help',
]);

const ACTIVE_FILE_TYPES = new Set<RequestType>([
	'code_explanation',
	'oop_confusion',
]);

const LOADABLE_RELATED_KINDS = new Set<WorkspaceFileKind>([
	'code',
	'question',
	'text',
	'build',
	'pdf',
]);

const SOCIAL_ONLY_PATTERN =
	/^(你好|您好|谢谢|感谢|再见|你是谁|hello|hi|thanks|thank you)[！!。.？?\s]*$/i;
const ASSIGNMENT_FOLLOW_UP_PATTERN =
	/(这题|题目|思路|怎么写|怎么做|从哪开始|下一步|这里|这个类|这个函数|为什么|不对|看不懂|不会|接下来|然后呢|哪里错|写错|结果.*(?:是|全是)?0|选哪个|怎么补|到底怎么|和答案)/i;
const EXPLICIT_ASSIGNMENT_SWITCH_PATTERN =
	/(换一题|换个题|另一题|新题|换个问题|另外一个作业|切换(?:到)?(?:题目|作业))/i;
const FIRST_CALL_SCOPE_FILE_LIMIT = 20;
const FIRST_CALL_SCOPE_BYTE_LIMIT = 300 * 1024;
const FIRST_CALL_ACTIVE_DIRECTORY_FILE_LIMIT = 10;
const FIRST_CALL_ACTIVE_DIRECTORY_BYTE_LIMIT = 200 * 1024;

function normalizePath(value: string): string {
	return value.replace(/\\/g, '/').replace(/^\.\//, '');
}

function comparablePath(value: string): string {
	return normalizePath(value).toLocaleLowerCase();
}

function directoryOf(value: string): string {
	const directory = path.posix.dirname(normalizePath(value));
	return directory === '' ? '.' : directory;
}

function isInsideDirectory(filePath: string, directory: string): boolean {
	const normalizedFile = comparablePath(filePath);
	const normalizedDirectory = comparablePath(directory).replace(/\/+$/, '');
	return normalizedDirectory === '.'
		? !normalizedFile.startsWith('../')
		: normalizedFile === normalizedDirectory
			|| normalizedFile.startsWith(`${normalizedDirectory}/`);
}

function isDirectlyInsideDirectory(filePath: string, directory: string): boolean {
	return comparablePath(directoryOf(filePath)) === comparablePath(directory);
}

function isBulkLoadable(entry: WorkspaceFileEntry): boolean {
	return LOADABLE_RELATED_KINDS.has(entry.kind)
		&& path.posix.basename(normalizePath(entry.path)).toLocaleLowerCase() !== 'classmate.md';
}

function requestKey(request: ContextRequest): string {
	return [
		request.source,
		comparablePath(request.target),
		request.section?.trim().toLocaleLowerCase() ?? '',
	].join('|');
}

function uniqueRequests(requests: ContextRequest[]): ContextRequest[] {
	const merged = new Map<string, ContextRequest>();
	for (const request of requests) {
		const key = requestKey(request);
		const existing = merged.get(key);
		if (!existing) {
			merged.set(key, request);
			continue;
		}
		if (request.required && !existing.required) {
			merged.set(key, {
				...existing,
				required: true,
				reason: request.reason,
			});
		}
	}
	return [...merged.values()];
}

function requiredFirst(requests: ContextRequest[]): ContextRequest[] {
	return uniqueRequests(requests).sort(
		(left, right) => Number(right.required) - Number(left.required)
	);
}

export interface WorkspaceSignals {
	hasQuestionFile: boolean;
	hasActiveCodeFile: boolean;
	hasBuildFile: boolean;
	looksLikeAssignmentWorkspace: boolean;
}

export interface AssignmentWorkspaceAssessment {
	isAssignmentWorkspace: boolean;
	assignmentRoot?: string;
	evidence: string[];
}

export function detectWorkspaceSignals(
	workspace: MinimalWorkspaceContext
): WorkspaceSignals {
	const activePath = workspace.catalog.activeEditor?.fileName;
	const activeEntry = activePath
		? workspace.catalog.files.find((entry) =>
			comparablePath(entry.path) === comparablePath(activePath))
		: undefined;
	const hasQuestionFile = Boolean(
		workspace.questionFile
		|| workspace.catalog.questionFiles.length > 0
		|| workspace.catalog.files.some((entry) =>
			entry.kind === 'question')
	);
	const hasActiveCodeFile = activeEntry?.kind === 'code';
	const hasBuildFile = workspace.catalog.files.some((entry) => entry.kind === 'build');
	return {
		hasQuestionFile,
		hasActiveCodeFile,
		hasBuildFile,
		looksLikeAssignmentWorkspace: hasQuestionFile || hasActiveCodeFile,
	};
}

/**
 * Makes a deterministic local assignment judgement before asking the model.
 * The model may add evidence, but it cannot remove these file-based signals.
 */
export function assessAssignmentWorkspace(
	workspace: MinimalWorkspaceContext,
	previous?: ConversationWorkspaceContext
): AssignmentWorkspaceAssessment {
	const signals = detectWorkspaceSignals(workspace);
	const assignmentRoot = deriveProblemRoot(workspace, previous);
	const evidence: string[] = [];
	if (workspace.questionFile) {
		evidence.push(`problem statement: ${workspace.questionFile}`);
	}
	if (signals.hasActiveCodeFile) {
		evidence.push(`active code file: ${workspace.catalog.activeEditor?.fileName}`);
	}
	if (signals.hasBuildFile) {
		evidence.push('build file found');
	}
	if (previous?.isAssignmentWorkspace) {
		evidence.push('continued assignment conversation');
	}
	return {
		isAssignmentWorkspace:
			signals.looksLikeAssignmentWorkspace
			|| Boolean(previous?.isAssignmentWorkspace),
		assignmentRoot,
		evidence,
	};
}

/**
 * Gives ambiguous homework-style questions a file-aware task type.
 * Clear classifications are never overwritten, and pure social chat remains chat.
 */
export function biasRequestTypeForWorkspace(
	requestType: RequestType,
	userText: string,
	workspace: MinimalWorkspaceContext,
	previous?: ConversationWorkspaceContext
): RequestType {
	if (requestType !== 'chat' && requestType !== 'unclassified') {
		return requestType;
	}
	if (SOCIAL_ONLY_PATTERN.test(userText.trim())) {
		return 'chat';
	}
	const signals = detectWorkspaceSignals(workspace);
	if (!signals.looksLikeAssignmentWorkspace) {
		return requestType;
	}
	if (
		previous?.previousRequestType
		&& !EXPLICIT_ASSIGNMENT_SWITCH_PATTERN.test(userText)
	) {
		return previous.previousRequestType;
	}
	if (ASSIGNMENT_FOLLOW_UP_PATTERN.test(userText)) {
		return 'problem_hint';
	}
	return requestType;
}

export function inferContextMode(
	requestType: RequestType,
	workspace: MinimalWorkspaceContext,
	userText: string,
	previous?: ConversationWorkspaceContext
): ContextMode {
	if (PROBLEM_TYPES.has(requestType)) {
		return 'problem_context';
	}
	if (DEBUG_TYPES.has(requestType)) {
		return 'debug_context';
	}
	if (requestType === 'code_edit') {
		return 'edit_context';
	}
	if (ACTIVE_FILE_TYPES.has(requestType)) {
		return 'active_file';
	}
	if (requestType === 'concept_explanation') {
		return detectWorkspaceSignals(workspace).looksLikeAssignmentWorkspace
			? 'active_file'
			: 'none';
	}
	if (
		previous?.previousContextMode
		&& !EXPLICIT_ASSIGNMENT_SWITCH_PATTERN.test(userText)
	) {
		return previous.previousContextMode;
	}
	return 'none';
}

/**
 * Runtime policy has the final say. The model may ask for a wider context mode,
 * but it cannot reduce the deterministic minimum required by the task type.
 */
export function resolveContextMode(
	requestType: RequestType,
	proposedMode: ContextMode | undefined,
	workspace: MinimalWorkspaceContext,
	userText: string,
	previous?: ConversationWorkspaceContext
): ContextMode {
	const minimum = inferContextMode(requestType, workspace, userText, previous);
	if (requestType === 'chat' && SOCIAL_ONLY_PATTERN.test(userText.trim())) {
		return 'none';
	}
	if (!proposedMode || proposedMode === 'none') {
		return minimum;
	}
	if (minimum === 'problem_context' || minimum === 'debug_context' || minimum === 'edit_context') {
		return minimum;
	}
	return proposedMode;
}

export function deriveProblemRoot(
	workspace: MinimalWorkspaceContext,
	previous?: ConversationWorkspaceContext
): string | undefined {
	if (workspace.questionFile) {
		return directoryOf(workspace.questionFile);
	}
	if (previous?.problemRoot) {
		return normalizePath(previous.problemRoot);
	}
	const activeFile = workspace.catalog.activeEditor?.fileName;
	return activeFile ? directoryOf(activeFile) : undefined;
}

function requestsForEntries(
	entries: WorkspaceFileEntry[],
	reason: string
): ContextRequest[] {
	return entries.map((entry) => makeAutomaticRequest(entry, false, reason));
}

function withinBudget(
	entries: WorkspaceFileEntry[],
	maxFiles: number,
	maxBytes: number
): boolean {
	return entries.length > 0
		&& entries.length <= maxFiles
		&& entries.reduce((sum, entry) => sum + entry.size, 0) <= maxBytes;
}

/**
 * Selects the bounded file bodies that may be submitted in the first
 * RouteAndPlan call. This is intentionally stricter than the final answer
 * loader: at most 20 files/300 KiB for the assignment scope, or at most
 * 10 files/200 KiB for the active file's direct directory.
 */
export function selectFirstCallWorkspaceRequests(
	workspace: MinimalWorkspaceContext,
	previous?: ConversationWorkspaceContext
): ContextRequest[] {
	const selected: ContextRequest[] = [];
	const catalogByPath = new Map(
		workspace.catalog.files.map((entry) => [comparablePath(entry.path), entry])
	);
	const questionPath = workspace.questionFile ?? previous?.questionPath;
	const questionEntry = questionPath
		? catalogByPath.get(comparablePath(questionPath))
		: undefined;
	const activePath = workspace.catalog.activeEditor?.fileName;
	const activeEntry = activePath
		? catalogByPath.get(comparablePath(activePath))
		: undefined;

	if (questionEntry && isBulkLoadable(questionEntry)) {
		selected.push(makeAutomaticRequest(
			questionEntry,
			false,
			'The nearest problem statement is included in the first planning call.'
		));
	}
	if (activeEntry && isBulkLoadable(activeEntry)) {
		selected.push(makeAutomaticRequest(
			activeEntry,
			false,
			'The active file is included in the first planning call.'
		));
	}

	const assignmentRoot = relatedScopeDirectory(workspace, previous) ?? '.';
	const scopedEntries = workspace.catalog.files.filter((entry) =>
		isBulkLoadable(entry) && isInsideDirectory(entry.path, assignmentRoot));
	if (withinBudget(
		scopedEntries,
		FIRST_CALL_SCOPE_FILE_LIMIT,
		FIRST_CALL_SCOPE_BYTE_LIMIT
	)) {
		selected.push(...requestsForEntries(
			scopedEntries,
			'Small assignment scope is included in the first planning call.'
		));
		return requiredFirst(selected);
	}

	const activeDirectory = activePath ? directoryOf(activePath) : undefined;
	const directEntries = activeDirectory
		? workspace.catalog.files.filter((entry) =>
			isBulkLoadable(entry) && isDirectlyInsideDirectory(entry.path, activeDirectory))
		: [];
	if (withinBudget(
		directEntries,
		FIRST_CALL_ACTIVE_DIRECTORY_FILE_LIMIT,
		FIRST_CALL_ACTIVE_DIRECTORY_BYTE_LIMIT
	)) {
		selected.push(...requestsForEntries(
			directEntries,
			'Small active directory is included in the first planning call.'
		));
	}
	return requiredFirst(selected);
}

/**
 * Last-resort requests used when an assignment was detected but normal
 * selection loaded nothing. All requests remain optional, so one missing or
 * oversized file cannot discard the other useful files.
 */
export function selectAssignmentFallbackRequests(
	workspace: MinimalWorkspaceContext,
	previous?: ConversationWorkspaceContext
): ContextRequest[] {
	const selected = selectFirstCallWorkspaceRequests(workspace, previous);
	const activePath = workspace.catalog.activeEditor?.fileName;
	const activeDirectory = activePath ? directoryOf(activePath) : undefined;
	if (activeDirectory) {
		selected.push(...requestsForEntries(
			workspace.catalog.files.filter((entry) =>
				isBulkLoadable(entry) && isDirectlyInsideDirectory(entry.path, activeDirectory)),
			'Assignment fallback includes a file beside the active file.'
		));
	}
	for (const previousPath of previous?.relatedPaths ?? []) {
		const entry = workspace.catalog.files.find(
			(candidate) => comparablePath(candidate.path) === comparablePath(previousPath)
		);
		if (entry && isBulkLoadable(entry)) {
			selected.push(makeAutomaticRequest(
				entry,
				false,
				'Assignment fallback reuses a file from the previous turn.'
			));
		}
	}
	return requiredFirst(selected);
}

function relatedScopeDirectory(
	workspace: MinimalWorkspaceContext,
	previous?: ConversationWorkspaceContext
): string | undefined {
	const problemRoot = deriveProblemRoot(workspace, previous);
	const activeFile = workspace.catalog.activeEditor?.fileName;
	const activeDirectory = activeFile ? directoryOf(activeFile) : undefined;

	// A question.md at workspace root must not make every assignment in the
	// workspace related. In that case, use the active file's directory.
	if (problemRoot === '.' && activeDirectory && activeDirectory !== '.') {
		return activeDirectory;
	}
	return problemRoot ?? activeDirectory;
}

function relatedFilePriority(
	entry: WorkspaceFileEntry,
	workspace: MinimalWorkspaceContext,
	explicitTargets: Set<string>
): number {
	const normalized = comparablePath(entry.path);
	if (explicitTargets.has(normalized)) {
		return 0;
	}
	if (workspace.questionFile && normalized === comparablePath(workspace.questionFile)) {
		return 1;
	}
	if (
		workspace.catalog.activeEditor?.fileName
		&& normalized === comparablePath(workspace.catalog.activeEditor.fileName)
	) {
		return 2;
	}
	if (entry.kind === 'code') {
		return 3;
	}
	if (entry.kind === 'build') {
		return 4;
	}
	if (entry.kind === 'question' || entry.kind === 'pdf') {
		return 5;
	}
	return 6;
}

function makeAutomaticRequest(
	entry: WorkspaceFileEntry,
	required: boolean,
	reason: string
): ContextRequest {
	return {
		source: 'workspace',
		target: entry.path,
		required,
		reason,
	};
}

export interface SelectWorkspaceContextInput {
	requestType: RequestType;
	contextMode: ContextMode;
	workspace: MinimalWorkspaceContext;
	userText: string;
	modelRequests: ContextRequest[];
	explicitRequests: ContextRequest[];
	previous?: ConversationWorkspaceContext;
}

/**
 * Selects context by relationship rather than by a fixed file count.
 * For problem_context, every validated, supported file in the current problem
 * directory is requested. The loader still enforces per-file and total budgets.
 */
export function selectWorkspaceContextRequests(
	input: SelectWorkspaceContextInput
): ContextRequest[] {
	const { workspace, contextMode } = input;
	const catalogByPath = new Map(
		workspace.catalog.files.map((entry) => [comparablePath(entry.path), entry])
	);
	const explicitTargets = new Set(
		input.explicitRequests.map((request) => comparablePath(request.target))
	);
	const selected: ContextRequest[] = [
		...input.explicitRequests,
		...input.modelRequests,
	];

	// A selected problem statement is deterministic context. It must not be
	// dropped merely because the model proposed contextMode=none.
	const questionPath = workspace.questionFile ?? input.previous?.questionPath;
	if (questionPath) {
		const questionEntry = catalogByPath.get(comparablePath(questionPath));
		if (questionEntry) {
			selected.push(makeAutomaticRequest(
				questionEntry,
				true,
				'The nearest problem statement is required for this assignment task.'
			));
		}
	}

	for (const previousPath of input.previous?.relatedPaths ?? []) {
		const entry = catalogByPath.get(comparablePath(previousPath));
		if (entry && LOADABLE_RELATED_KINDS.has(entry.kind)) {
			selected.push(makeAutomaticRequest(
				entry,
				false,
				'This file was part of the previous turn for the same conversation.'
			));
		}
	}

	if (contextMode === 'none') {
		return requiredFirst(selected);
	}

	const activePath = workspace.catalog.activeEditor?.fileName;
	const activeEntry = activePath ? catalogByPath.get(comparablePath(activePath)) : undefined;
	if (activeEntry && LOADABLE_RELATED_KINDS.has(activeEntry.kind)) {
		selected.push(makeAutomaticRequest(
			activeEntry,
			true,
			'The active file is required by the selected context mode.'
		));
	}

	if (contextMode === 'active_file' || contextMode === 'edit_context') {
		if (activeEntry) {
			const activeBaseName = path.posix.basename(
				normalizePath(activeEntry.path),
				path.posix.extname(normalizePath(activeEntry.path))
			).toLocaleLowerCase();
			const activeDirectory = directoryOf(activeEntry.path);
			for (const entry of workspace.catalog.files) {
				const entryBaseName = path.posix.basename(
					normalizePath(entry.path),
					path.posix.extname(normalizePath(entry.path))
				).toLocaleLowerCase();
				if (
					entry.kind === 'code'
					&& directoryOf(entry.path) === activeDirectory
					&& entryBaseName === activeBaseName
				) {
					selected.push(makeAutomaticRequest(
						entry,
						false,
						'This source/header file is paired with the active file.'
					));
				}
			}
		}
		return requiredFirst(selected);
	}

	const scopeDirectory = relatedScopeDirectory(workspace, input.previous);
	if (scopeDirectory) {
		const relatedEntries = workspace.catalog.files
			.filter((entry) =>
				LOADABLE_RELATED_KINDS.has(entry.kind)
				&& path.posix.basename(normalizePath(entry.path)).toLocaleLowerCase() !== 'classmate.md'
				&& isInsideDirectory(entry.path, scopeDirectory)
			)
			.sort((left, right) => {
				const priority = relatedFilePriority(left, workspace, explicitTargets)
					- relatedFilePriority(right, workspace, explicitTargets);
				return priority || left.path.localeCompare(right.path);
			});
		for (const entry of relatedEntries) {
			selected.push(makeAutomaticRequest(
				entry,
				false,
				'This file belongs to the current problem directory.'
			));
		}
	}

	return requiredFirst(selected);
}
