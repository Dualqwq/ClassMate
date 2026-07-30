import type { SkillRetrievalQuery } from '../graph/types';
import type { SkillCandidate, SkillGraph, SkillNode } from './types';

function normalize(value: string): string {
	return value.toLocaleLowerCase().replace(/\s+/g, '');
}

function containsEither(left: string, right: string): boolean {
	const a = normalize(left);
	const b = normalize(right);
	return a.length > 0 && b.length > 0 && (a.includes(b) || b.includes(a));
}

function ratio(matched: number, total: number): number {
	return total === 0 ? 0 : matched / total;
}

function scoreNode(node: SkillNode, query: SkillRetrievalQuery): SkillCandidate {
	const searchable = [node.title, ...node.concepts, ...node.aliases];
	const matchedConcepts = query.concepts.filter((concept) =>
		searchable.some((candidate) => containsEither(concept, candidate))
	);
	const matchedPurposes = query.purposes.filter((purpose) => node.purposes.includes(purpose));
	const requestTypeMatch = node.requestTypes.includes(query.requestType) ? 1 : 0;
	const learnerLevelMatch = node.learnerLevels.includes(query.learnerLevel)
		|| node.learnerLevels.includes('unknown') ? 1 : 0;

	const conceptMatch = ratio(matchedConcepts.length, query.concepts.length);
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
