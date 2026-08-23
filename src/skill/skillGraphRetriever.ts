import type { SkillRetrievalQuery } from '../graph/types';
import type { SkillCandidate, SkillGraph, SkillNode } from './types';

function normalize(value: string): string {
	return value.toLocaleLowerCase().replace(/\s+/g, '');
}

/**
 * Scores one natural-language query against one catalog phrase.
 *
 * An exact phrase is much stronger evidence than a short word contained in a
 * long student question. Without this distinction, a question such as
 * “直方图为什么用栈” gives the generic word “栈” the same weight as the exact
 * histogram alias and may retrieve an unrelated stack topic first.
 */
function matchStrength(left: string, right: string): number {
	const a = normalize(left);
	const b = normalize(right);
	if (a.length === 0 || b.length === 0) {
		return 0;
	}
	if (a === b) {
		return 1;
	}
	if (b.includes(a)) {
		return Math.max(0.7, a.length / b.length);
	}
	if (a.includes(b)) {
		return Math.max(0.15, b.length / a.length);
	}
	return 0;
}

function ratio(matched: number, total: number): number {
	return total === 0 ? 0 : matched / total;
}

function scoreNode(node: SkillNode, query: SkillRetrievalQuery): SkillCandidate {
	const searchable = [node.title, ...node.concepts, ...node.aliases];
	const conceptMatches = query.concepts.map((concept) => ({
		concept,
		strength: Math.max(
			0,
			...searchable.map((candidate) => matchStrength(concept, candidate))
		),
	}));
	const matchedConcepts = conceptMatches
		.filter((match) => match.strength > 0)
		.map((match) => match.concept);
	const matchedPurposes = query.purposes.filter((purpose) => node.purposes.includes(purpose));
	const requestTypeMatch = node.requestTypes.includes(query.requestType) ? 1 : 0;
	const learnerLevelMatch = node.learnerLevels.includes(query.learnerLevel)
		|| node.learnerLevels.includes('unknown') ? 1 : 0;

	const conceptMatch = query.concepts.length === 0
		? 0
		: conceptMatches.reduce((sum, match) => sum + match.strength, 0)
			/ query.concepts.length;
	const purposeMatch = ratio(matchedPurposes.length, query.purposes.length);
	const score =
		conceptMatch * 0.45 +
		requestTypeMatch * 0.25 +
		purposeMatch * 0.20 +
		learnerLevelMatch * 0.10;

	const matchedBy = [
		...matchedConcepts.map((concept) => `concept:${concept}`),
		...(requestTypeMatch ? [`requestType:${query.requestType}`] : []),
		...matchedPurposes.map((purpose) => `purpose:${purpose}`),
	];

	return { node, score, matchedBy, relationsUsed: [] };
}

export function retrieveSkillCandidates(
	graph: SkillGraph,
	query: SkillRetrievalQuery,
	maxCandidates = 12
): SkillCandidate[] {
	const scored = graph.nodes
		.map((node) => scoreNode(node, query))
		.filter((candidate) => candidate.score > 0);

	const byId = new Map(graph.nodes.map((node) => [node.id, node]));
	const candidatesById = new Map(scored.map((candidate) => [candidate.node.id, candidate]));
	const seeds = [...scored]
		.sort((a, b) => b.score - a.score || a.node.id.localeCompare(b.node.id))
		.slice(0, Math.max(query.maxSections * 2, 4));

	for (const seed of seeds) {
		for (const relation of seed.node.relations) {
			const target = byId.get(relation.target);
			if (!target) {
				continue;
			}
			const relationLabel = `${seed.node.id}:${relation.type}`;
			const existing = candidatesById.get(target.id);
			if (existing) {
				existing.score = Math.min(1, existing.score + 0.12);
				if (!existing.relationsUsed.includes(relationLabel)) {
					existing.relationsUsed.push(relationLabel);
				}
			} else {
				candidatesById.set(target.id, {
					node: target,
					score: 0.15,
					matchedBy: [],
					relationsUsed: [relationLabel],
				});
			}
		}
	}

	return [...candidatesById.values()]
		.sort((a, b) => b.score - a.score || a.node.id.localeCompare(b.node.id))
		.slice(0, maxCandidates);
}
