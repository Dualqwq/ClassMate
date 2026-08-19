import { createHash } from 'crypto';
import { z } from 'zod';
import type { WorkspaceContextSnapshot } from '../workspace/types';

export type Bug1ReviewVerdict = 'pass' | 'fail' | 'unjudgeable' | 'skip';
export type Bug1DeliveryOutcome =
	| 'answered'
	| 'grounded_local_hint'
	| 'generic_fallback'
	| 'provider_error'
	| 'cancelled';

export interface Bug1DatasetMutation {
	file: string;
	replace: {
		from: string;
		to: string;
	};
}

export interface Bug1WorkspaceEvidenceFile {
	path: string;
	kind: string;
	content: string;
	contentHash: string;
	reason: string;
}

export interface Bug1WorkspaceEvidence {
	snapshotId: string;
	files: Bug1WorkspaceEvidenceFile[];
}

export interface Bug1EvalResult {
	conversationId: string;
	turn: number;
	sourceProblem: string;
	workspace: string;
	activeFile: string | null;
	prompt: string;
	expectedIntent: string;
	mustUse: string[];
	mustAvoid: string[];
	mutations: Bug1DatasetMutation[];
	appliedMutations?: Array<Bug1DatasetMutation & {
		beforeContent: string;
		afterContent: string;
		beforeHash: string;
		afterHash: string;
	}>;
	answer: string;
	status: 'success' | 'failed';
	deliveryOutcome: Bug1DeliveryOutcome;
	/** 分层度量:证词层(模型标记)与展示层(inferred 补链)分开计数。 */
	answerReferenceStats?: {
		references: number;
		modelMarkedLinks: number;
		inferredLinks: number;
	};
	/** 程序侧块来源证词(不渲染):栅栏代码块的确定性溯源结果。 */
	answerBlockSources?: Array<{
		blockIndex: number;
		status: 'unique' | 'unique-file' | 'ambiguous' | 'none';
		file?: string;
		targetId?: string;
	}>;
	/** 模型实际收到的 Tree-sitter 引用目标清单。 */
	referenceTargetsReceived?: string[];
	error?: string;
	startedAt: string;
	firstTokenMs?: number;
	totalDurationMs: number;
	graphDurationMs?: number;
	usageByNode: Record<string, unknown>;
	actualRequestType?: string;
	contextMode?: string;
	loadedWorkspaceFiles?: string[];
	workspaceEvidence: Bug1WorkspaceEvidence;
	[key: string]: unknown;
}

export interface Bug1EvalCheckpoint {
	schemaVersion: 2;
	version: string;
	startedAt: string;
	updatedAt: string;
	provider: string;
	model: string;
	plannedTurns: number;
	results: Bug1EvalResult[];
}

export interface Bug1ReviewItem extends Bug1EvalResult {
	reviewId: string;
	caseHash: string;
	runHash: string;
}

export interface Bug1ReviewBundle {
	schemaVersion: 1;
	generatedAt: string;
	source: {
		version: string;
		provider: string;
		model: string;
		startedAt: string;
		updatedAt: string;
	};
	items: Bug1ReviewItem[];
}

export interface Bug1HumanJudgment {
	schemaVersion: 1;
	reviewId: string;
	verdict: Bug1ReviewVerdict;
	dimensions: {
		workspaceGrounded: boolean;
		answersQuestion: boolean;
		teachingHelpful: boolean;
		hintLevelCompliant: boolean;
		referencesCorrect: boolean | null;
		genericFallback: boolean;
	};
	failureTags: string[];
	notes?: string;
	reviewer: string;
	reviewedAt: string;
	caseHash: string;
	runHash: string;
}

export interface Bug1HumanJudgmentDraft {
	verdict: Bug1ReviewVerdict;
	dimensions: Bug1HumanJudgment['dimensions'];
	failureTags: string[];
	notes?: string;
	reviewer: string;
}

export interface Bug1JudgmentFile {
	schemaVersion: 1;
	updatedAt: string;
	judgments: Bug1HumanJudgment[];
}

export interface MatchedHumanJudgments {
	valid: Bug1HumanJudgment[];
	stale: Bug1HumanJudgment[];
	orphaned: Bug1HumanJudgment[];
}

export interface Bug1ReviewSummary {
	total: number;
	reviewed: number;
	unreviewed: number;
	stale: number;
	verdicts: Record<Bug1ReviewVerdict, number>;
}

const mutationSchema = z.object({
	file: z.string().min(1),
	replace: z.object({
		from: z.string(),
		to: z.string(),
	}).strict(),
}).strict();

const workspaceEvidenceFileSchema = z.object({
	path: z.string().min(1),
	kind: z.string().min(1),
	content: z.string(),
	contentHash: z.string().min(1),
	reason: z.string(),
}).strict();

const workspaceEvidenceSchema = z.object({
	snapshotId: z.string().min(1),
	files: z.array(workspaceEvidenceFileSchema),
}).strict();

const evalResultSchema = z.object({
	conversationId: z.string().min(1),
	turn: z.number().int().positive(),
	sourceProblem: z.string(),
	workspace: z.string().min(1),
	activeFile: z.string().nullable(),
	prompt: z.string().min(1),
	expectedIntent: z.string().min(1),
	mustUse: z.array(z.string()),
	mustAvoid: z.array(z.string()),
	mutations: z.array(mutationSchema),
	appliedMutations: z.array(mutationSchema.extend({
		beforeContent: z.string(),
		afterContent: z.string(),
		beforeHash: z.string().min(1),
		afterHash: z.string().min(1),
	})).optional(),
	answer: z.string(),
	status: z.enum(['success', 'failed']),
	deliveryOutcome: z.enum([
		'answered',
		'grounded_local_hint',
		'generic_fallback',
		'provider_error',
		'cancelled',
	]),
	answerReferenceStats: z.object({
		references: z.number().nonnegative(),
		modelMarkedLinks: z.number().nonnegative(),
		inferredLinks: z.number().nonnegative(),
	}).optional(),
	answerBlockSources: z.array(z.object({
		blockIndex: z.number().nonnegative(),
		status: z.enum(['unique', 'unique-file', 'ambiguous', 'none']),
		file: z.string().optional(),
		targetId: z.string().optional(),
	})).optional(),
	referenceTargetsReceived: z.array(z.string()).optional(),
	error: z.string().optional(),
	startedAt: z.string().min(1),
	firstTokenMs: z.number().nonnegative().optional(),
	totalDurationMs: z.number().nonnegative(),
	graphDurationMs: z.number().nonnegative().optional(),
	usageByNode: z.record(z.unknown()),
	actualRequestType: z.string().optional(),
	contextMode: z.string().optional(),
	loadedWorkspaceFiles: z.array(z.string()).optional(),
	workspaceEvidence: workspaceEvidenceSchema,
}).passthrough();

const evalCheckpointSchema = z.object({
	schemaVersion: z.literal(2),
	version: z.string().min(1),
	startedAt: z.string().min(1),
	updatedAt: z.string().min(1),
	provider: z.string().min(1),
	model: z.string().min(1),
	plannedTurns: z.number().int().nonnegative(),
	results: z.array(evalResultSchema),
}).strict();

export function parseBug1EvalCheckpoint(value: unknown): Bug1EvalCheckpoint {
	const checkpoint = evalCheckpointSchema.parse(value) as Bug1EvalCheckpoint;
	const reviewIds = new Set<string>();
	for (const result of checkpoint.results) {
		const reviewId = reviewIdOf(result);
		if (reviewIds.has(reviewId)) {
			throw new Error(`Duplicate review id: ${reviewId}`);
		}
		reviewIds.add(reviewId);
	}
	return checkpoint;
}

export function buildBug1WorkspaceEvidence(
	snapshot: WorkspaceContextSnapshot
): Bug1WorkspaceEvidence {
	return {
		snapshotId: snapshot.snapshotId,
		files: snapshot.loadedItems.map((item) => ({
			path: item.path,
			kind: item.kind,
			content: item.content,
			contentHash: item.contentHash,
			reason: item.reason,
		})),
	};
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(canonicalJson).join(',')}]`;
	}
	if (value !== null && typeof value === 'object') {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
			.join(',')}}`;
	}
	return JSON.stringify(value);
}

function hashValue(value: unknown): string {
	return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function reviewIdOf(result: Bug1EvalResult): string {
	return `${result.conversationId}#${result.turn}`;
}

function caseIdentity(result: Bug1EvalResult): unknown {
	return {
		reviewId: reviewIdOf(result),
		sourceProblem: result.sourceProblem,
		workspace: result.workspace,
		activeFile: result.activeFile,
		prompt: result.prompt,
		expectedIntent: result.expectedIntent,
		mustUse: result.mustUse,
		mustAvoid: result.mustAvoid,
		mutations: result.mutations,
		workspaceEvidence: result.workspaceEvidence,
		answerReferenceStats: result.answerReferenceStats,
		answerBlockSources: result.answerBlockSources,
		referenceTargetsReceived: result.referenceTargetsReceived,
	};
}

function runIdentity(
	checkpoint: Bug1EvalCheckpoint,
	result: Bug1EvalResult,
	caseHash: string
): unknown {
	return {
		caseHash,
		version: checkpoint.version,
		provider: checkpoint.provider,
		model: checkpoint.model,
		status: result.status,
		deliveryOutcome: result.deliveryOutcome,
		error: result.error,
		answer: result.answer,
		actualRequestType: result.actualRequestType,
		contextMode: result.contextMode,
	};
}

export function buildBug1ReviewBundle(
	checkpoint: Bug1EvalCheckpoint
): Bug1ReviewBundle {
	const items = checkpoint.results.map((result) => {
		const caseHash = hashValue(caseIdentity(result));
		return {
			...result,
			reviewId: reviewIdOf(result),
			caseHash,
			runHash: hashValue(runIdentity(checkpoint, result, caseHash)),
		};
	});
	return {
		schemaVersion: 1,
		generatedAt: checkpoint.updatedAt,
		source: {
			version: checkpoint.version,
			provider: checkpoint.provider,
			model: checkpoint.model,
			startedAt: checkpoint.startedAt,
			updatedAt: checkpoint.updatedAt,
		},
		items,
	};
}

export function matchHumanJudgments(
	bundle: Bug1ReviewBundle,
	judgments: Bug1HumanJudgment[]
): MatchedHumanJudgments {
	const itemsById = new Map(bundle.items.map((item) => [item.reviewId, item]));
	const valid: Bug1HumanJudgment[] = [];
	const stale: Bug1HumanJudgment[] = [];
	const orphaned: Bug1HumanJudgment[] = [];
	for (const judgment of judgments) {
		const item = itemsById.get(judgment.reviewId);
		if (!item) {
			orphaned.push(judgment);
		} else if (
			judgment.caseHash !== item.caseHash
			|| judgment.runHash !== item.runHash
		) {
			stale.push(judgment);
		} else {
			valid.push(judgment);
		}
	}
	return { valid, stale, orphaned };
}

export function summarizeBug1Review(
	bundle: Bug1ReviewBundle,
	judgments: Bug1HumanJudgment[]
): Bug1ReviewSummary {
	const matched = matchHumanJudgments(bundle, judgments);
	const reviewedIds = new Set(matched.valid.map((judgment) => judgment.reviewId));
	const verdicts: Record<Bug1ReviewVerdict, number> = {
		pass: 0,
		fail: 0,
		unjudgeable: 0,
		skip: 0,
	};
	for (const judgment of matched.valid) {
		verdicts[judgment.verdict] += 1;
	}
	return {
		total: bundle.items.length,
		reviewed: reviewedIds.size,
		unreviewed: Math.max(0, bundle.items.length - reviewedIds.size),
		stale: matched.stale.length,
		verdicts,
	};
}
