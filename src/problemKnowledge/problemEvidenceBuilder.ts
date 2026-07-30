import { createHash } from 'crypto';
import type {
	ProblemEvidenceInput,
	ProblemRecognitionEvidence,
} from './types';

const MAX_WORKSPACE_PATHS = 200;
const MAX_QUESTION_SNIPPETS = 10;
const MAX_CODE_MARKERS = 30;
const MAX_SNIPPET_CHARS = 220;
const QUESTION_SIGNAL_PATTERN =
	/(数据范围|输入格式|输出格式|时间限制|空间限制|复杂度|插入|删除|查询|翻转|最近邻|最短路|模式匹配|连通块|祖玛|zuma|splay|kd\s*tree|dijkstra)/i;
const CODE_MARKER_PATTERN =
	/\b(?:class|struct|void|int|long\s+long|size_t|bool|char|string|vector|Node|node)\s+([A-Za-z_][A-Za-z0-9_]*)|\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;

function compactLine(value: string): string {
	return value.replace(/\s+/g, ' ').trim().slice(0, MAX_SNIPPET_CHARS);
}

function unique(values: string[], max: number): string[] {
	return [...new Set(values.filter(Boolean))].slice(0, max);
}

function extractQuestionSnippets(content: string): string[] {
	const lines = content.split(/\r?\n/).map(compactLine).filter(Boolean);
	const headings = lines.filter((line) => /^#{1,3}\s/.test(line)).slice(0, 3);
	const signals = lines.filter((line) => QUESTION_SIGNAL_PATTERN.test(line)).slice(0, 6);
	const opening = lines.slice(0, 2);
	return unique([...headings, ...opening, ...signals], MAX_QUESTION_SNIPPETS);
}

function extractCodeMarkers(content: string): string[] {
	const markers: string[] = [];
	for (const match of content.matchAll(CODE_MARKER_PATTERN)) {
		const name = match[1] ?? match[2];
		if (name && name.length >= 2) {
			markers.push(name);
		}
		if (markers.length >= MAX_CODE_MARKERS) {
			break;
		}
	}
	const distinctiveLines = content
		.split(/\r?\n/)
		.map(compactLine)
		.filter((line) =>
			/(insert|erase|getline|cin\s*>>|plen|play\s*\(|split|merge|lazy|compare\s*\()/i.test(line))
		.slice(0, 10);
	return unique([...markers, ...distinctiveLines], MAX_CODE_MARKERS);
}

export function buildProblemRecognitionEvidence(
	input: ProblemEvidenceInput
): ProblemRecognitionEvidence {
	const workspacePaths = input.workspace.catalog.files
		.map((file) => file.path.replace(/\\/g, '/'))
		.slice(0, MAX_WORKSPACE_PATHS);
	const focusedPaths = unique([
		input.workspace.catalog.activeEditor?.fileName?.replace(/\\/g, '/') ?? '',
		input.workspace.questionFile?.replace(/\\/g, '/') ?? '',
		...input.loadedItems.map((item) => item.path.replace(/\\/g, '/')),
	], MAX_WORKSPACE_PATHS);
	const questionSnippets = unique(
		input.loadedItems
			.filter((item) => item.kind === 'question' || item.kind === 'text')
			.flatMap((item) => extractQuestionSnippets(item.content)),
		MAX_QUESTION_SNIPPETS
	);
	const codeMarkers = unique(
		input.loadedItems
			.filter((item) => item.kind === 'code')
			.flatMap((item) => extractCodeMarkers(item.content)),
		MAX_CODE_MARKERS
	);
	const loadedContentHashes = input.loadedItems.map((item) => item.contentHash);
	const fingerprintSource = JSON.stringify({
		activeFile: input.workspace.catalog.activeEditor?.fileName,
		questionFile: input.workspace.questionFile,
		loaded: input.loadedItems.map((item) => [item.path, item.contentHash]),
	});
	return {
		fingerprint: createHash('sha256').update(fingerprintSource, 'utf8').digest('hex'),
		userText: input.userText.slice(0, 2_000),
		workspacePaths,
		focusedPaths,
		activeFile: input.workspace.catalog.activeEditor?.fileName,
		questionFile: input.workspace.questionFile,
		questionSnippets,
		codeMarkers,
		loadedContentHashes,
	};
}
