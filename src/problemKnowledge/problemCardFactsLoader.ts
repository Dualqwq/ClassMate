import { z } from 'zod';
import type { SkillContentLoader } from '../skill/skillContentLoader';
import type {
	LoadedProblemCardFacts,
	ProblemCardFacts,
	ProblemCardFactsIndex,
	ProblemCardIndex,
} from './types';

const verifiedTestSchema = z.object({
	name: z.string().trim().min(1).max(120),
	input: z.string().max(20_000),
	expectedOutput: z.string().max(20_000),
	purpose: z.string().trim().min(1).max(500),
}).strict();

const factsSchema = z.object({
	id: z.string().trim().regex(/^[a-z0-9][a-z0-9.-]*$/).max(160),
	kind: z.enum(['solution', 'diagnostic']),
	primaryConclusion: z.string().trim().min(1).max(1_000),
	evidence: z.array(z.string().trim().min(1).max(1_000)).min(1).max(20),
	complexity: z.object({
		time: z.string().trim().min(1).max(300),
		space: z.string().trim().min(1).max(300),
	}).strict().optional(),
	pitfalls: z.array(z.string().trim().min(1).max(1_000)).max(20),
	verifiedTests: z.array(verifiedTestSchema).max(10),
	rejectedClaims: z.array(z.string().trim().min(1).max(1_000)).max(20),
	answerRequirements: z.array(z.string().trim().min(1).max(1_000)).min(1).max(20),
}).strict();

const factsIndexSchema = z.object({
	schemaVersion: z.literal(1),
	factsVersion: z.string().trim().min(1).max(100),
	entries: z.array(factsSchema).min(1).max(1_000),
}).strict();

/**
 * 加载机器可验证的题目事实，并保证它与题目匹配索引一一对应。
 *
 * Markdown 卡片负责教学文字；本文件只处理主结论、证据、复杂度和测试数据。
 */
export class ProblemCardFactsLoader {
	private _cached?: ProblemCardFactsIndex;

	constructor(
		private readonly _loader: SkillContentLoader,
		private readonly _factsPath = 'graph/problem-card-facts.json'
	) {}

	public async load(index: ProblemCardIndex): Promise<ProblemCardFactsIndex> {
		if (this._cached) {
			return this._cached;
		}
		const raw = await this._loader.loadJson<unknown>(this._factsPath);
		const facts = factsIndexSchema.parse(raw) as ProblemCardFactsIndex;
		this._validateCoverage(index, facts);
		this._cached = facts;
		return facts;
	}

	public async select(
		index: ProblemCardIndex,
		cardId: string,
		variantId?: string
	): Promise<LoadedProblemCardFacts> {
		const indexedCard = index.cards.find((candidate) => candidate.id === cardId);
		if (!indexedCard) {
			throw new Error(`Unknown problem card selected: ${cardId}`);
		}
		if (
			variantId &&
			!indexedCard.variants.some((candidate) => candidate.id === variantId)
		) {
			throw new Error(
				`Problem variant ${variantId} does not belong to card ${cardId}`
			);
		}
		const facts = await this.load(index);
		const byId = new Map(facts.entries.map((entry) => [entry.id, entry]));
		const card = byId.get(cardId);
		if (!card) {
			throw new Error(`Missing structured facts for problem card: ${cardId}`);
		}
		const variant = variantId ? byId.get(variantId) : undefined;
		if (variantId && !variant) {
			throw new Error(`Missing structured facts for problem variant: ${variantId}`);
		}
		return { card, variant };
	}

	public clear(): void {
		this._cached = undefined;
		this._loader.clear(this._factsPath);
	}

	private _validateCoverage(
		index: ProblemCardIndex,
		facts: ProblemCardFactsIndex
	): void {
		const expectedKinds = new Map<string, ProblemCardFacts['kind']>();
		for (const card of index.cards) {
			expectedKinds.set(card.id, 'solution');
			for (const variant of card.variants) {
				expectedKinds.set(variant.id, 'diagnostic');
			}
		}
		const actualIds = new Set<string>();
		for (const entry of facts.entries) {
			if (actualIds.has(entry.id)) {
				throw new Error(`Duplicate structured problem facts id: ${entry.id}`);
			}
			const expectedKind = expectedKinds.get(entry.id);
			if (!expectedKind) {
				throw new Error(`Structured problem facts reference an unknown id: ${entry.id}`);
			}
			if (entry.kind !== expectedKind) {
				throw new Error(
					`Structured problem facts ${entry.id} must use kind ${expectedKind}`
				);
			}
			actualIds.add(entry.id);
		}
		for (const id of expectedKinds.keys()) {
			if (!actualIds.has(id)) {
				throw new Error(`Structured problem facts are missing id: ${id}`);
			}
		}
	}
}
