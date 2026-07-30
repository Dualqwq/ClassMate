import { z } from 'zod';
import { requestTypeSchema } from '../graph/schemas';
import type { SkillGraph } from './types';
import {
	isMarkdownReferencePath,
	SkillContentLoader,
} from './skillContentLoader';

const relationTypeSchema = z.enum([
	'prerequisite',
	'next_concept',
	'confused_with',
	'has_misconception',
	'has_example',
	'used_for_debugging',
	'response_pattern',
	'explains',
]);

const purposeSchema = z.enum([
	'definition',
	'example',
	'debug',
	'misconception',
	'prerequisite',
	'response_pattern',
]);

const skillGraphSchema = z.object({
	schemaVersion: z.literal(1),
	graphVersion: z.string().trim().min(1).max(100),
	nodes: z.array(z.object({
		id: z.string().trim().regex(/^[a-z0-9][a-z0-9.-]*$/).max(120),
		title: z.string().trim().min(1).max(200),
		source: z.object({
			path: z.string().trim().min(1).max(300),
			headingPath: z.array(z.string().trim().min(1).max(200)).min(1).max(6),
		}).strict(),
		concepts: z.array(z.string().trim().min(1).max(100)).max(30),
		aliases: z.array(z.string().trim().min(1).max(150)).max(30),
		requestTypes: z.array(requestTypeSchema).max(15),
		purposes: z.array(purposeSchema).max(6),
		learnerLevels: z.array(z.enum(['beginner', 'intermediate', 'unknown'])).max(3),
		relations: z.array(z.object({
			type: relationTypeSchema,
			target: z.string().trim().min(1).max(120),
		}).strict()).max(30),
	}).strict()).max(1000),
}).strict();

export class SkillGraphLoader {
	private _cached?: SkillGraph;

	constructor(
		private readonly _loader: SkillContentLoader,
		private readonly _graphPath = 'graph/skill-graph.json'
	) {}

	public async load(): Promise<SkillGraph> {
		if (this._cached) {
			return this._cached;
		}
		const raw = await this._loader.loadJson<unknown>(this._graphPath);
		const graph = skillGraphSchema.parse(raw) as SkillGraph;

		const ids = new Set<string>();
		for (const node of graph.nodes) {
			if (ids.has(node.id)) {
				throw new Error(`Duplicate Skill graph node id: ${node.id}`);
			}
			ids.add(node.id);
			if (!isMarkdownReferencePath(node.source.path)) {
				throw new Error(`Skill graph node uses a disallowed source path: ${node.source.path}`);
			}
		}
		for (const node of graph.nodes) {
			for (const relation of node.relations) {
				if (!ids.has(relation.target)) {
					throw new Error(
						`Skill graph relation target does not exist: ${node.id} -> ${relation.target}`
					);
				}
			}
		}

		this._cached = graph;
		return graph;
	}

	public clear(): void {
		this._cached = undefined;
		this._loader.clear(this._graphPath);
	}
}
