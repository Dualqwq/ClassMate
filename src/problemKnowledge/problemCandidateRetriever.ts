import type {
	ProblemCard,
	ProblemCardCandidate,
	ProblemCardFingerprint,
	ProblemCardIndex,
	ProblemRecognitionEvidence,
} from './types';

function normalize(value: string): string {
	return value
		.toLocaleLowerCase()
		.replace(/[_.\s/\\()[\]（）【】\-]+/g, '');
}

function includesEither(left: string, right: string): boolean {
	const a = normalize(left);
	const b = normalize(right);
	return a.length >= 2 && b.length >= 2 && (a.includes(b) || b.includes(a));
}

function matchValues(
	haystacks: string[],
	needles: string[],
	label: string,
	weight: number,
	cap: number
): { score: number; matchedBy: string[] } {
	const matched = needles.filter((needle) =>
		haystacks.some((haystack) => includesEither(haystack, needle))
	);
	return {
		score: Math.min(cap, matched.length * weight),
		matchedBy: matched.map((value) => `${label}:${value}`),
	};
}

function scoreFingerprint(
	fingerprint: ProblemCardFingerprint,
	evidence: ProblemRecognitionEvidence
): { score: number; matchedBy: string[] } {
	const paths = [
		evidence.activeFile ?? '',
		evidence.questionFile ?? '',
		...evidence.focusedPaths,
	];
	const text = [evidence.userText, ...evidence.questionSnippets];
	const code = evidence.codeMarkers;
	const groups = [
		matchValues(paths, fingerprint.pathTokens, 'path', 0.20, 0.55),
		matchValues(text, fingerprint.titleTokens, 'title', 0.24, 0.48),
		matchValues(text, fingerprint.distinctivePhrases, 'phrase', 0.16, 0.48),
		matchValues(text, fingerprint.concepts, 'concept', 0.06, 0.18),
		matchValues(code, fingerprint.codeMarkers, 'code', 0.10, 0.30),
	];
	const exactHashes = fingerprint.contentHashes.filter((hash) =>
		evidence.loadedContentHashes.includes(hash));
	if (exactHashes.length > 0) {
		groups.push({
			score: 0.90,
			matchedBy: exactHashes.map((hash) => `contentHash:${hash.slice(0, 12)}`),
		});
	}
	return {
		score: Math.min(1, groups.reduce((sum, group) => sum + group.score, 0)),
		matchedBy: groups.flatMap((group) => group.matchedBy),
	};
}

function scoreCard(
	card: ProblemCard,
	evidence: ProblemRecognitionEvidence
): ProblemCardCandidate {
	const base = scoreFingerprint(card.fingerprints, evidence);
	const identityText = [
		evidence.userText,
		evidence.activeFile ?? '',
		evidence.questionFile ?? '',
		...evidence.focusedPaths,
		...evidence.questionSnippets,
	];
	const identityTokens = [card.number, ...card.ojIds, card.title, ...card.aliases];
	const identity = matchValues(identityText, identityTokens, 'identity', 0.18, 0.54);
	const variantScores = card.variants
		.map((variant) => {
			const result = scoreFingerprint(variant.fingerprints, evidence);
			return { variant, ...result };
		})
		.filter((variant) => variant.score > 0)
		.sort((left, right) => right.score - left.score);
	return {
		card,
		score: Math.min(1, base.score + identity.score),
		matchedBy: [...base.matchedBy, ...identity.matchedBy],
		variantScores,
	};
}

export function retrieveProblemCardCandidates(
	index: ProblemCardIndex,
	evidence: ProblemRecognitionEvidence,
	maxCandidates = 5
): ProblemCardCandidate[] {
	return index.cards
		.map((card) => scoreCard(card, evidence))
		.filter((candidate) => candidate.score > 0)
		.sort((left, right) =>
			right.score - left.score || left.card.id.localeCompare(right.card.id))
		.slice(0, maxCandidates);
}
