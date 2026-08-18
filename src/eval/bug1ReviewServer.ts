import { promises as fs } from 'fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import * as path from 'path';
import {
	buildBug1ReviewBundle,
	matchHumanJudgments,
	parseBug1EvalCheckpoint,
	summarizeBug1Review,
	type Bug1HumanJudgment,
	type Bug1HumanJudgmentDraft,
	type Bug1JudgmentFile,
	type Bug1ReviewBundle,
} from './bug1Review';

const DEFAULT_HOST = '127.0.0.1';
const MAX_REQUEST_BYTES = 256 * 1024;

export interface StartBug1ReviewServerOptions {
	checkpointPath: string;
	judgmentsPath: string;
	host?: string;
	port?: number;
	uiHtml?: string;
}

export interface RunningBug1ReviewServer {
	url: string;
	close(): Promise<void>;
}

interface ReviewState {
	bundle: Bug1ReviewBundle;
	judgments: Bug1HumanJudgment[];
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
	response.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'cache-control': 'no-store',
	});
	response.end(JSON.stringify(value));
}

function sendText(
	response: ServerResponse,
	status: number,
	contentType: string,
	value: string
): void {
	response.writeHead(status, {
		'content-type': contentType,
		'cache-control': 'no-store',
		'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'",
	});
	response.end(value);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		total += buffer.byteLength;
		if (total > MAX_REQUEST_BYTES) {
			throw new Error('Request body is too large.');
		}
		chunks.push(buffer);
	}
	return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function isBoolean(value: unknown): value is boolean {
	return typeof value === 'boolean';
}

function parseDraft(value: unknown): Bug1HumanJudgmentDraft {
	if (value === null || typeof value !== 'object') {
		throw new Error('Judgment must be an object.');
	}
	const draft = value as Record<string, unknown>;
	if (!['pass', 'fail', 'unjudgeable', 'skip'].includes(String(draft.verdict))) {
		throw new Error('Judgment verdict is invalid.');
	}
	if (typeof draft.reviewer !== 'string' || !draft.reviewer.trim()) {
		throw new Error('Judgment reviewer is required.');
	}
	if (!Array.isArray(draft.failureTags) || !draft.failureTags.every((tag) => typeof tag === 'string')) {
		throw new Error('Judgment failureTags must be a string array.');
	}
	if (draft.notes !== undefined && typeof draft.notes !== 'string') {
		throw new Error('Judgment notes must be a string.');
	}
	if (draft.dimensions === null || typeof draft.dimensions !== 'object') {
		throw new Error('Judgment dimensions are required.');
	}
	const dimensions = draft.dimensions as Record<string, unknown>;
	if (
		!isBoolean(dimensions.workspaceGrounded)
		|| !isBoolean(dimensions.answersQuestion)
		|| !isBoolean(dimensions.teachingHelpful)
		|| !isBoolean(dimensions.hintLevelCompliant)
		|| !isBoolean(dimensions.genericFallback)
		|| !(
			dimensions.referencesCorrect === null
			|| isBoolean(dimensions.referencesCorrect)
		)
	) {
		throw new Error('Judgment dimensions are invalid.');
	}
	return {
		verdict: draft.verdict as Bug1HumanJudgmentDraft['verdict'],
		dimensions: {
			workspaceGrounded: dimensions.workspaceGrounded,
			answersQuestion: dimensions.answersQuestion,
			teachingHelpful: dimensions.teachingHelpful,
			hintLevelCompliant: dimensions.hintLevelCompliant,
			referencesCorrect: dimensions.referencesCorrect,
			genericFallback: dimensions.genericFallback,
		},
		failureTags: [...draft.failureTags],
		notes: draft.notes as string | undefined,
		reviewer: draft.reviewer.trim(),
	};
}

async function readJudgments(judgmentsPath: string): Promise<Bug1HumanJudgment[]> {
	try {
		const parsed = JSON.parse(await fs.readFile(judgmentsPath, 'utf8')) as Bug1JudgmentFile;
		return Array.isArray(parsed.judgments) ? parsed.judgments : [];
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return [];
		}
		throw error;
	}
}

async function writeJudgments(
	judgmentsPath: string,
	judgments: Bug1HumanJudgment[]
): Promise<void> {
	await fs.mkdir(path.dirname(judgmentsPath), { recursive: true });
	const value: Bug1JudgmentFile = {
		schemaVersion: 1,
		updatedAt: new Date().toISOString(),
		judgments,
	};
	const temporaryPath = `${judgmentsPath}.tmp`;
	await fs.writeFile(temporaryPath, JSON.stringify(value, null, 2), 'utf8');
	await fs.rename(temporaryPath, judgmentsPath);
}

function sessionPayload(state: ReviewState): unknown {
	const matched = matchHumanJudgments(state.bundle, state.judgments);
	return {
		bundle: state.bundle,
		validJudgments: matched.valid,
		staleJudgments: matched.stale,
		orphanedJudgments: matched.orphaned,
		summary: summarizeBug1Review(state.bundle, state.judgments),
	};
}

const DEFAULT_UI = '<!doctype html><html><body><h1>ClassMate bug1 review</h1></body></html>';

export async function startBug1ReviewServer(
	options: StartBug1ReviewServerOptions
): Promise<RunningBug1ReviewServer> {
	const checkpoint = parseBug1EvalCheckpoint(JSON.parse(
		await fs.readFile(options.checkpointPath, 'utf8')
	));
	const state: ReviewState = {
		bundle: buildBug1ReviewBundle(checkpoint),
		judgments: await readJudgments(options.judgmentsPath),
	};
	let writeQueue = Promise.resolve();

	const server = createServer(async (request, response) => {
		try {
			const requestUrl = new URL(request.url ?? '/', 'http://localhost');
			if (request.method === 'GET' && requestUrl.pathname === '/') {
				sendText(response, 200, 'text/html; charset=utf-8', options.uiHtml ?? DEFAULT_UI);
				return;
			}
			if (request.method === 'GET' && requestUrl.pathname === '/api/session') {
				sendJson(response, 200, sessionPayload(state));
				return;
			}
			const judgmentMatch = requestUrl.pathname.match(/^\/api\/judgments\/(.+)$/);
			if (request.method === 'PUT' && judgmentMatch) {
				const reviewId = decodeURIComponent(judgmentMatch[1]);
				const item = state.bundle.items.find((candidate) => candidate.reviewId === reviewId);
				if (!item) {
					sendJson(response, 404, { error: 'Review item not found.' });
					return;
				}
				const draft = parseDraft(await readJsonBody(request));
				const judgment: Bug1HumanJudgment = {
					schemaVersion: 1,
					reviewId,
					...draft,
					reviewedAt: new Date().toISOString(),
					caseHash: item.caseHash,
					runHash: item.runHash,
				};
				state.judgments = [
					...state.judgments.filter((candidate) => candidate.reviewId !== reviewId),
					judgment,
				];
				writeQueue = writeQueue.then(() =>
					writeJudgments(options.judgmentsPath, state.judgments)
				);
				await writeQueue;
				sendJson(response, 200, { judgment });
				return;
			}
			sendJson(response, 404, { error: 'Not found.' });
		} catch (error) {
			sendJson(response, 400, {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	});

	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(options.port ?? 0, options.host ?? DEFAULT_HOST, () => {
			server.off('error', reject);
			resolve();
		});
	});
	const address = server.address();
	if (!address || typeof address === 'string') {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		throw new Error('Review server did not provide a TCP address.');
	}
	const host = options.host ?? DEFAULT_HOST;
	return {
		url: `http://${host}:${address.port}`,
		close: () => new Promise<void>((resolve, reject) => {
			server.close((error) => error ? reject(error) : resolve());
		}),
	};
}
