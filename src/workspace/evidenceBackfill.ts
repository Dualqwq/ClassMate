import type { ContextRequest } from '../graph/types';
import type { LoadedWorkspaceItem, MinimalWorkspaceContext } from './types';

/** 7.8 恢复通道:同一目标最多补读次数(计划口径:缺证据最多补读两轮)。 */
export const MAX_EVIDENCE_BACKFILL_ROUNDS = 2;

/** 触发补读的代码类请求类型(与 runner 的 HIGH_RISK 集合无关,按"需要看代码"界定)。 */
const CODE_EVIDENCE_REQUEST_TYPES = new Set<string>([
	'code_explanation',
	'compile_error_help',
	'runtime_error_help',
	'wrong_output_help',
	'oj_failure_help',
	'debug_suggestion',
	'code_edit',
	'problem_hint',
	'solution_request',
]);

function comparablePath(value: string): string {
	return value.replace(/\\/g, '/').toLocaleLowerCase();
}

function stemOf(path: string): string {
	const base = path.replace(/\\/g, '/').split('/').pop() ?? path;
	return base.split('.')[0] ?? base;
}

function codeFileOf(path: string): boolean {
	return /\.(?:cpp|cc|cxx|c|h|hpp|hh|hxx)$/i.test(path.replace(/\\/g, '/'));
}

export interface EvidenceBackfillInput {
	userText: string;
	requestType?: string;
	minimal: MinimalWorkspaceContext;
	loadedItems: LoadedWorkspaceItem[];
	/** 已补读过的目标(含首轮 load_context 的请求),防同一文件反复补。 */
	processedTargets: ReadonlySet<string>;
	/** 已完成的补读轮数。 */
	backfillCount: number;
}

export interface EvidenceBackfillPlan {
	requests: ContextRequest[];
	reason: 'named_file_missing' | 'no_code_loaded';
}

/**
 * 程序侧确定性判定"缺代码证据"并生成补读请求:
 * 1. 用户文本点名了工作区存在的代码文件(文件名词干出现在提问里)但未加载;
 * 2. 加载的代码条目为 0、活动文件是代码文件、且问题属于代码类请求。
 * 找不到可补读目标时返回空 requests(调用方继续原链路,不再循环)。
 * 每轮最多补读一个目标:先解决"最被点名的文件",不足再由下一轮判定。
 */
export function planEvidenceBackfill(
	input: EvidenceBackfillInput
): EvidenceBackfillPlan | undefined {
	if (input.backfillCount >= MAX_EVIDENCE_BACKFILL_ROUNDS) {
		return undefined;
	}
	const loadedPaths = new Set(
		input.loadedItems.map((item) => comparablePath(item.path))
	);
	// 用户点名的代码文件:词干出现在提问文本(大小写不敏感)、catalog 里
	// 存在、未加载、未补过。
	const loweredText = input.userText.toLocaleLowerCase();
	const named = input.minimal.catalog.files
		.filter((entry) => codeFileOf(entry.path))
		.filter((entry) => {
			const stem = stemOf(entry.path).toLocaleLowerCase();
			return stem.length >= 2 && loweredText.includes(stem);
		})
		.filter((entry) => {
			const key = comparablePath(entry.path);
			return !loadedPaths.has(key) && !input.processedTargets.has(key);
		})
		.sort((a, b) => a.path.localeCompare(b.path));
	if (named.length > 0) {
		return {
			requests: [{
				source: 'workspace',
				target: named[0].path,
				section: undefined,
				required: false,
				reason: 'Named code file was not loaded yet.',
			}],
			reason: 'named_file_missing',
		};
	}
	const loadedCode = input.loadedItems.filter((item) => item.kind === 'code');
	if (
		loadedCode.length === 0
		&& input.requestType !== undefined
		&& CODE_EVIDENCE_REQUEST_TYPES.has(input.requestType)
	) {
		const activePath = input.minimal.catalog.activeEditor?.fileName;
		if (
			activePath
			&& codeFileOf(activePath)
			&& !input.processedTargets.has(comparablePath(activePath))
		) {
			return {
				requests: [{
					source: 'workspace',
					target: activePath,
					section: undefined,
					required: false,
					reason: 'No code file was loaded for a code question; loading the active file.',
				}],
				reason: 'no_code_loaded',
			};
		}
	}
	return undefined;
}
