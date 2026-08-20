import * as assert from 'assert';
import { promises as fs } from 'fs';
import * as path from 'path';
import { describe, it } from 'mocha';
import * as vscode from 'vscode';
import type { ClassMateDevelopmentApi } from '../extension';
import { ClassMateGraphRunner } from '../graph/ClassMateGraphRunner';
import type {
	ConversationWorkspaceContext,
	RequestType,
} from '../graph/types';
import type { LLMTokenUsage } from '../llm/types';
import { addTokenUsage } from '../llm/tokenUsage';
import { SkillContentLoader } from '../skill/skillContentLoader';
import { SkillGraphLoader } from '../skill/skillGraphLoader';
import { SkillSectionExtractor } from '../skill/skillSectionExtractor';
import { ProblemCardExtractor } from '../problemKnowledge/problemCardExtractor';
import { ProblemCardFactsLoader } from '../problemKnowledge/problemCardFactsLoader';
import { ProblemCardIndexLoader } from '../problemKnowledge/problemCardIndexLoader';
import type { MinimalWorkspaceContext, WorkspaceFileEntry } from '../workspace/types';
import { WorkspaceContextLoader } from '../workspace/workspaceContextLoader';
import {
	getWorkspaceFileKind,
	isProblemStatementPath,
	selectProblemFile,
} from '../workspace/workspaceContextProvider';
import type { WorkspaceContextProvider } from '../workspace/workspaceContextProvider';
import {
	buildBug1WorkspaceEvidence,
	type Bug1DatasetMutation,
	type Bug1EvalCheckpoint,
	type Bug1EvalResult,
} from '../eval/bug1Review';
import { summarizeReferenceLinks } from '../chat/answerReferenceRenderer';
import {
	openBug1WorkspaceScenario,
	type Bug1AppliedMutation,
} from '../eval/bug1WorkspaceScenario';

const LIVE_EVAL_ENABLED = process.env.CLASSMATE_LIVE_EVAL === '1';
const EXCLUDED_DIRECTORIES = new Set([
	'.git',
	'.vscode',
	'.vscode-test',
	'node_modules',
	'dist',
	'out',
	'gold',
]);

interface DatasetTurn {
	turn: number;
	prompt: string;
	expected_intent: RequestType;
	must_use: string[];
	must_avoid: string[];
	mutations?: Bug1DatasetMutation[];
}

interface DatasetCase {
	id: string;
	source_problem: string;
	workspace: string;
	active_file: string | null;
	prompt?: string;
	expected_intent?: RequestType;
	must_use?: string[];
	must_avoid?: string[];
	mutations?: Bug1DatasetMutation[];
	turns?: DatasetTurn[];
}

interface LiveEvalResult extends Bug1EvalResult {
	expectedIntent: RequestType;
	usage?: LLMTokenUsage;
	usageByNode: Record<string, LLMTokenUsage>;
	nodeTimings?: unknown[];
	actualRequestType?: RequestType;
	retrievedSkillIds?: string[];
	conversationWorkspaceContext?: ConversationWorkspaceContext;
	problemIdentification?: unknown;
	problemConstraints?: unknown;
	constraintExtractionDegraded?: boolean;
	correctnessCheckRequired?: boolean;
	correctnessVerification?: unknown;
	answerRetryCount?: number;
	problemCandidates?: Array<{
		id: string;
		score: number;
		variants: Array<{ id: string; score: number }>;
	}>;
}

interface LiveEvalCheckpoint extends Omit<Bug1EvalCheckpoint, 'results'> {
	results: LiveEvalResult[];
}

function parseJsonLines<T>(content: string): T[] {
	return content
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => JSON.parse(line) as T);
}

async function scanWorkspace(
	workspacePath: string,
	activeFile: string | null
): Promise<MinimalWorkspaceContext> {
	const files: WorkspaceFileEntry[] = [];
	const visit = async (directory: string): Promise<void> => {
		for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
			if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name.toLowerCase())) {
				continue;
			}
			const absolutePath = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				await visit(absolutePath);
				continue;
			}
			if (!entry.isFile()) {
				continue;
			}
			const uri = vscode.Uri.file(absolutePath);
			const kind = getWorkspaceFileKind(uri);
			if (kind === 'other') {
				continue;
			}
			const stat = await fs.stat(absolutePath);
			files.push({
				path: path.relative(workspacePath, absolutePath).replace(/\\/g, '/'),
				uri: uri.toString(),
				kind,
				size: stat.size,
				modifiedAt: stat.mtimeMs,
			});
		}
	};
	await visit(workspacePath);
	files.sort((left, right) => left.path.localeCompare(right.path));

	const activePath = activeFile ? path.resolve(workspacePath, activeFile) : undefined;
	const activeUri = activePath ? vscode.Uri.file(activePath) : undefined;
	const problemEntries = files.filter((entry) => isProblemStatementPath(entry.path));
	const selectedProblem = selectProblemFile(
		problemEntries
			.filter((entry) => entry.kind !== 'pdf')
			.map((entry) => vscode.Uri.parse(entry.uri)),
		problemEntries
			.filter((entry) => entry.kind === 'pdf')
			.map((entry) => vscode.Uri.parse(entry.uri)),
		activeUri
	);
	const questionFile = selectedProblem
		? path.relative(workspacePath, selectedProblem.fsPath).replace(/\\/g, '/')
		: undefined;

	return {
		catalog: {
			files,
			questionFiles: problemEntries.map((entry) => entry.path),
			activeEditor: activePath && activeUri ? {
				fileName: path.relative(workspacePath, activePath).replace(/\\/g, '/'),
				uri: activeUri.toString(),
				languageId: getWorkspaceFileKind(activeUri) === 'code' ? 'cpp' : 'markdown',
			} : undefined,
		},
		questionFile,
	};
}

async function saveCheckpoint(
	outputPath: string,
	checkpoint: LiveEvalCheckpoint
): Promise<void> {
	checkpoint.updatedAt = new Date().toISOString();
	const temporaryPath = `${outputPath}.tmp`;
	await fs.writeFile(temporaryPath, JSON.stringify(checkpoint, null, 2), 'utf8');
	await fs.rename(temporaryPath, outputPath);
}

const liveDescribe = LIVE_EVAL_ENABLED ? describe : describe.skip;

liveDescribe('ClassMate OOP real API evaluation', function () {
	this.timeout(4 * 60 * 60 * 1000);

	it('runs every single-turn and multi-turn dataset case', async () => {
		const datasetRoot = process.env.CLASSMATE_EVAL_ROOT;
		const outputPath = process.env.CLASSMATE_EVAL_OUTPUT;
		if (!datasetRoot || !outputPath) {
			throw new Error('CLASSMATE_EVAL_ROOT and CLASSMATE_EVAL_OUTPUT are required.');
		}

		const extension = vscode.extensions.getExtension<ClassMateDevelopmentApi>(
			'undefined_publisher.classmate'
		);
		assert.ok(extension, 'ClassMate development extension is unavailable.');
		const api = await extension.activate();
		assert.ok(api, 'ClassMate development API is unavailable.');

		const allSingleCases = parseJsonLines<DatasetCase>(
			await fs.readFile(path.join(datasetRoot, 'dataset.jsonl'), 'utf8')
		);
		const multiDatasetPath = path.join(datasetRoot, 'multi-turn-dataset.jsonl');
		const multiCases = await fs.readFile(multiDatasetPath, 'utf8')
			.then((content) => parseJsonLines<DatasetCase>(content))
			.catch((error: NodeJS.ErrnoException) => {
				if (error.code === 'ENOENT') {
					return [];
				}
				throw error;
			});
		const mutationDatasetPath = path.join(datasetRoot, 'mutation-dataset.jsonl');
		const mutationCases = await fs.readFile(mutationDatasetPath, 'utf8')
			.then((content) => parseJsonLines<DatasetCase>(content))
			.catch((error: NodeJS.ErrnoException) => {
				if (error.code === 'ENOENT') {
					return [];
				}
				throw error;
			});
		const allMultiCases = [...multiCases, ...mutationCases];
		const requestedIds = new Set(
			(process.env.CLASSMATE_LIVE_EVAL_IDS ?? '')
				.split(',')
				.map((value) => value.trim())
				.filter(Boolean)
		);
		const singleCases = requestedIds.size > 0
			? allSingleCases.filter((item) => requestedIds.has(item.id))
			: allSingleCases;
		const selectedMultiCases = requestedIds.size > 0
			? allMultiCases.filter((item) => requestedIds.has(item.id))
			: allMultiCases;
		const allPlannedTurns = singleCases.length
			+ selectedMultiCases.reduce((sum, item) => sum + (item.turns?.length ?? 0), 0);
		const requestedLimit = Number(process.env.CLASSMATE_LIVE_EVAL_LIMIT);
		const plannedTurns = Number.isSafeInteger(requestedLimit) && requestedLimit > 0
			? Math.min(allPlannedTurns, requestedLimit)
			: allPlannedTurns;

		let currentUsageByNode: Record<string, LLMTokenUsage> = {};
		const liveModel = await api.createLiveEvalModel((usage, label) => {
			const key = label ?? 'unknown';
			currentUsageByNode[key] = addTokenUsage(currentUsageByNode[key], usage);
		});
		let checkpoint: LiveEvalCheckpoint;
		if (
			process.env.CLASSMATE_LIVE_EVAL_RESUME === '1'
			&& await fs.stat(outputPath).then(() => true, () => false)
		) {
			checkpoint = JSON.parse(
				await fs.readFile(outputPath, 'utf8')
			) as LiveEvalCheckpoint;
			if (
				checkpoint.schemaVersion !== 2
				||
				checkpoint.provider !== liveModel.provider
				|| checkpoint.model !== liveModel.model
				|| checkpoint.plannedTurns !== plannedTurns
			) {
				throw new Error('Existing checkpoint does not match this evaluation run.');
			}
			checkpoint.results = checkpoint.results.filter(
				(row) => row.status !== 'failed'
			);
		} else {
			checkpoint = {
				schemaVersion: 2,
				version: process.env.CLASSMATE_EVAL_VERSION
					?? '0.0.5-workspace-context-update',
				startedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				provider: liveModel.provider,
				model: liveModel.model,
				plannedTurns,
				results: [],
			};
		}
		await saveCheckpoint(outputPath, checkpoint);
		const completedByKey = new Map(
			checkpoint.results.map((row) => [
				`${row.conversationId}#${row.turn}`,
				row,
			])
		);

		const oopRoot = path.resolve(datasetRoot, '..');
		const runTurn = async (
			item: DatasetCase,
			turn: DatasetTurn,
			appliedMutations: Bug1AppliedMutation[],
			history: Array<{ role: 'user' | 'assistant'; content: string }>,
			previousWorkspaceContext?: ConversationWorkspaceContext
		): Promise<{
			answer?: string;
			workspaceContext?: ConversationWorkspaceContext;
		}> => {
			const workspacePath = path.resolve(datasetRoot, item.workspace);
			if (
				workspacePath !== oopRoot
				&& !workspacePath.startsWith(`${oopRoot}${path.sep}`)
			) {
				throw new Error(`Dataset workspace escapes OOP root: ${item.workspace}`);
			}
			const minimal = await scanWorkspace(workspacePath, item.active_file);
			const workspaceProvider = {
				getMinimalContext: async () => minimal,
			} as WorkspaceContextProvider;
			const skillRoot = vscode.Uri.file(
				path.join(extension.extensionPath, 'skill', 'classmate')
			);
			const skillContentLoader = new SkillContentLoader(skillRoot);
			const abortController = new AbortController();
			const timeout = setTimeout(() => abortController.abort(), 180_000);
			const startedAtMs = Date.now();
			const startedAt = new Date(startedAtMs).toISOString();
			let firstTokenMs: number | undefined;
			currentUsageByNode = {};
			try {
				const result = await new ClassMateGraphRunner({
					workspaceProvider,
					// 数据集工作区根,让引用契约生成指向真实文件的 URI。
					workspaceRootUri: vscode.Uri.file(workspacePath).toString(),
					workspaceLoader: new WorkspaceContextLoader(),
					skillContentLoader,
					skillGraphLoader: new SkillGraphLoader(skillContentLoader),
					skillSectionExtractor: new SkillSectionExtractor(skillContentLoader),
					problemCardIndexLoader: new ProblemCardIndexLoader(skillContentLoader),
					problemCardExtractor: new ProblemCardExtractor(skillContentLoader),
					problemCardFactsLoader: new ProblemCardFactsLoader(skillContentLoader),
					model: liveModel.client,
					signal: abortController.signal,
					onDebug: (event, data) => {
						if (event === 'answer_model_failed' || event === 'evidence_backfill') {
							console.warn(`[live-eval] ${event}:`, JSON.stringify(data));
						}
					},
				onAnswerToken: () => {
					firstTokenMs ??= Date.now() - startedAtMs;
				},
				}).run({
					requestId: `${item.id}-${turn.turn}-${Date.now()}`,
					conversationId: item.id,
					userText: turn.prompt,
					requestSource: 'conversation',
					conversationHistory: history,
					previousWorkspaceContext,
				});
				const usage = Object.values(currentUsageByNode).reduce(
					(total, value) => addTokenUsage(total, value),
					undefined as LLMTokenUsage | undefined
				);
				checkpoint.results.push({
					conversationId: item.id,
					turn: turn.turn,
					sourceProblem: item.source_problem,
					workspace: item.workspace,
					activeFile: item.active_file,
					prompt: turn.prompt,
					expectedIntent: turn.expected_intent,
					mustUse: turn.must_use ?? [],
					mustAvoid: turn.must_avoid ?? [],
					mutations: turn.mutations ?? [],
					appliedMutations,
					answer: result.answer,
					status: 'success',
					deliveryOutcome: result.state.answerOutcome ?? 'answered',
					// 分层度量:证词层(模型标记链接)与展示层(inferred 补链)分开计数。
					answerReferenceStats: {
						references: result.state.answerReferences?.length ?? 0,
						...summarizeReferenceLinks(result.answer),
					},
					// 模型实际收到的 Tree-sitter 引用目标清单(审计:标记率低时
					// 可判别是目录没下发还是模型没用)。
					referenceTargetsReceived: result.state.workspaceSymbols?.symbols.map(
						(symbol) => symbol.targetId
					) ?? [],
					// 7.7 结构事实核对:定位到的声明与冲突(证词,人工判卷复核)。
					groundingCheck: result.state.groundingCheck
						? {
							passed: result.state.groundingCheck.passed,
							retryCount: result.state.groundingRetryCount,
							conflicts: result.state.groundingCheck.conflicts as Array<Record<string, unknown>>,
						}
						: undefined,
					// 程序侧块来源证词(不渲染):供历史清洗与 7.7 校验审计。
					answerBlockSources: result.state.answerBlockSources ?? [],
					startedAt,
					firstTokenMs,
				// 首字可见延迟:流式轮取真实首 token;引用契约等缓冲交付轮
				// 在图完成时才对用户可见,取整轮时长(统计模块据此分桶)。
				firstVisibleMs: firstTokenMs
					?? (result.state.answer?.trim() ? Date.now() - startedAtMs : undefined),
					totalDurationMs: Date.now() - startedAtMs,
					graphDurationMs: result.totalDurationMs,
					usage,
					usageByNode: currentUsageByNode,
					nodeTimings: result.nodeTimings,
					actualRequestType: result.state.requestType,
					contextMode: result.state.contextMode,
					loadedWorkspaceFiles: result.state.loadedWorkspaceItems.map(
						(loaded) => loaded.path
					),
					workspaceEvidence: buildBug1WorkspaceEvidence(
						result.state.workspaceSnapshot!
					),
					retrievedSkillIds: result.state.retrievedSkillSections.map(
						(section) => section.nodeId
					),
					conversationWorkspaceContext:
						result.state.conversationWorkspaceContext,
					problemIdentification: result.state.problemIdentification,
					problemConstraints: result.state.problemConstraints,
					constraintExtractionDegraded:
						result.state.constraintExtractionDegraded,
					correctnessCheckRequired: result.state.correctnessCheckRequired,
					correctnessVerification: result.state.correctnessVerification,
					answerRetryCount: result.state.answerRetryCount,
					problemCandidates: result.state.problemCardCandidates.map((candidate) => ({
						id: candidate.card.id,
						score: candidate.score,
						variants: candidate.variantScores.map((variant) => ({
							id: variant.variant.id,
							score: variant.score,
						})),
					})),
				});
				await saveCheckpoint(outputPath, checkpoint);
				return {
					answer: result.answer,
					workspaceContext: result.state.conversationWorkspaceContext,
				};
			} catch (error) {
				const usage = Object.values(currentUsageByNode).reduce(
					(total, value) => addTokenUsage(total, value),
					undefined as LLMTokenUsage | undefined
				);
				checkpoint.results.push({
					conversationId: item.id,
					turn: turn.turn,
					sourceProblem: item.source_problem,
					workspace: item.workspace,
					activeFile: item.active_file,
					prompt: turn.prompt,
					expectedIntent: turn.expected_intent,
					mustUse: turn.must_use ?? [],
					mustAvoid: turn.must_avoid ?? [],
					mutations: turn.mutations ?? [],
					appliedMutations,
					answer: '',
					status: 'failed',
					deliveryOutcome: error instanceof Error && error.name === 'AbortError'
						? 'cancelled'
						: 'provider_error',
					error: error instanceof Error ? error.message : String(error),
					startedAt,
					firstTokenMs,
					totalDurationMs: Date.now() - startedAtMs,
					usage,
					usageByNode: currentUsageByNode,
					workspaceEvidence: {
						snapshotId: 'unavailable-after-failed-run',
						files: [],
					},
				});
				await saveCheckpoint(outputPath, checkpoint);
				return {};
			} finally {
				clearTimeout(timeout);
			}
		};

		for (const item of singleCases) {
			if (checkpoint.results.length >= plannedTurns) {
				break;
			}
			if (completedByKey.has(`${item.id}#1`)) {
				continue;
			}
			const workspacePath = path.resolve(datasetRoot, item.workspace);
			const scenario = await openBug1WorkspaceScenario(workspacePath);
			try {
				const mutations = item.mutations ?? [];
				const appliedMutations = await scenario.apply(mutations);
				await runTurn(item, {
					turn: 1,
					prompt: item.prompt!,
					expected_intent: item.expected_intent!,
					must_use: item.must_use ?? [],
					must_avoid: item.must_avoid ?? [],
					mutations,
				}, appliedMutations, []);
			} finally {
				await scenario.restore();
			}
		}

		multiCaseLoop: for (const item of selectedMultiCases) {
			const workspacePath = path.resolve(datasetRoot, item.workspace);
			const scenario = await openBug1WorkspaceScenario(workspacePath);
			try {
				const history: Array<{ role: 'user' | 'assistant'; content: string }> = [];
				let previousWorkspaceContext: ConversationWorkspaceContext | undefined;
				for (const turn of item.turns ?? []) {
					if (checkpoint.results.length >= plannedTurns) {
						break multiCaseLoop;
					}
					const appliedMutations = await scenario.apply(turn.mutations ?? []);
					const completed = completedByKey.get(`${item.id}#${turn.turn}`);
					if (completed) {
						if (completed.status === 'success' && completed.answer) {
							history.push(
								{ role: 'user', content: turn.prompt },
								{ role: 'assistant', content: completed.answer }
							);
						}
						previousWorkspaceContext =
							completed.conversationWorkspaceContext
								?? previousWorkspaceContext;
						continue;
					}
					const turnResult = await runTurn(
						item,
						turn,
						appliedMutations,
						history,
						previousWorkspaceContext
					);
					if (turnResult.answer) {
						history.push(
							{ role: 'user', content: turn.prompt },
							{ role: 'assistant', content: turnResult.answer }
						);
					}
					previousWorkspaceContext =
						turnResult.workspaceContext ?? previousWorkspaceContext;
				}
			} finally {
				await scenario.restore();
			}
		}

		assert.strictEqual(checkpoint.results.length, plannedTurns);
	});
});
