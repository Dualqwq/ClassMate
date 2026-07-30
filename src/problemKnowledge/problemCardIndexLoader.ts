import { z } from 'zod';
import {
	isMarkdownReferencePath,
	SkillContentLoader,
} from '../skill/skillContentLoader';
import type { ProblemCardIndex } from './types';

const sourceSchema = z.object({
	path: z.string().trim().min(1).max(300),
	headingPath: z.array(z.string().trim().min(1).max(200)).min(1).max(6),
}).strict();

const fingerprintSchema = z.object({
	pathTokens: z.array(z.string().trim().min(1).max(100)).max(30),
	titleTokens: z.array(z.string().trim().min(1).max(100)).max(30),
	distinctivePhrases: z.array(z.string().trim().min(2).max(200)).max(20),
	concepts: z.array(z.string().trim().min(1).max(100)).max(30),
	codeMarkers: z.array(z.string().trim().min(2).max(200)).max(30),
	contentHashes: z.array(z.string().trim().regex(/^[a-f0-9]{64}$/)).max(20),
}).strict();

const variantSchema = z.object({
	id: z.string().trim().regex(/^[a-z0-9][a-z0-9.-]*$/).max(160),
	title: z.string().trim().min(1).max(200),
	source: sourceSchema,
	fingerprints: fingerprintSchema,
}).strict();

const cardSchema = z.object({
	id: z.string().trim().regex(/^[a-z0-9][a-z0-9.-]*$/).max(160),
	course: z.literal('data-structures'),
	series: z.string().trim().min(1).max(50),
	number: z.string().trim().min(1).max(50),
	ojIds: z.array(z.string().trim().min(1).max(30)).max(10),
	title: z.string().trim().min(1).max(200),
	aliases: z.array(z.string().trim().min(1).max(100)).max(30),
	source: sourceSchema,
	fingerprints: fingerprintSchema,
	variants: z.array(variantSchema).max(30),
}).strict();

const indexSchema = z.object({
	schemaVersion: z.literal(1),
	indexVersion: z.string().trim().min(1).max(100),
	cards: z.array(cardSchema).min(1).max(500),
}).strict();

export class ProblemCardIndexLoader {
	private _cached?: ProblemCardIndex;

	constructor(
		private readonly _loader: SkillContentLoader,
		private readonly _indexPath = 'graph/problem-card-index.json'
	) {}

	public async load(): Promise<ProblemCardIndex> {
		if (this._cached) {
			return this._cached;
		}
		const raw = await this._loader.loadJson<unknown>(this._indexPath);
		const index = indexSchema.parse(raw) as ProblemCardIndex;
		const ids = new Set<string>();
		for (const card of index.cards) {
			this._validateSource(card.source.path);
			this._addUniqueId(ids, card.id);
			for (const variant of card.variants) {
				this._validateSource(variant.source.path);
				this._addUniqueId(ids, variant.id);
			}
		}
		this._cached = index;
		return index;
	}

	public clear(): void {
		this._cached = undefined;
		this._loader.clear(this._indexPath);
	}

	private _validateSource(path: string): void {
		if (!isMarkdownReferencePath(path)) {
			throw new Error(`Problem card uses a disallowed source path: ${path}`);
		}
	}

	private _addUniqueId(ids: Set<string>, id: string): void {
		if (ids.has(id)) {
			throw new Error(`Duplicate problem card id: ${id}`);
		}
		ids.add(id);
	}
}
