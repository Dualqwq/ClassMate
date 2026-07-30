import type { LoadedWorkspaceItem, MinimalWorkspaceContext } from '../workspace/types';

export interface ProblemCardSource {
	path: string;
	headingPath: string[];
}

export interface ProblemCardFingerprint {
	pathTokens: string[];
	titleTokens: string[];
	distinctivePhrases: string[];
	concepts: string[];
	codeMarkers: string[];
	contentHashes: string[];
}

export interface ProblemCardVariant {
	id: string;
	title: string;
	source: ProblemCardSource;
	fingerprints: ProblemCardFingerprint;
}

export interface ProblemCard {
	id: string;
	course: 'data-structures';
	series: string;
	number: string;
	ojIds: string[];
	title: string;
	aliases: string[];
	source: ProblemCardSource;
	fingerprints: ProblemCardFingerprint;
	variants: ProblemCardVariant[];
}

export interface ProblemCardIndex {
	schemaVersion: 1;
	indexVersion: string;
	cards: ProblemCard[];
}

export interface ProblemCardVerifiedTest {
	name: string;
	input: string;
	expectedOutput: string;
	purpose: string;
}

export interface ProblemCardFacts {
	id: string;
	kind: 'solution' | 'diagnostic';
	primaryConclusion: string;
	evidence: string[];
	complexity?: {
		time: string;
		space: string;
	};
	pitfalls: string[];
	verifiedTests: ProblemCardVerifiedTest[];
	rejectedClaims: string[];
	answerRequirements: string[];
}

export interface ProblemCardFactsIndex {
	schemaVersion: 1;
	factsVersion: string;
	entries: ProblemCardFacts[];
}

export interface ProblemRecognitionEvidence {
	fingerprint: string;
	userText: string;
	/** 整个工作区的路径样本，只用于判断是否值得启动题目识别。 */
	workspacePaths: string[];
	/** 当前打开、确定为题面或本轮实际加载的路径，用于给具体卡片排序。 */
	focusedPaths: string[];
	activeFile?: string;
	questionFile?: string;
	questionSnippets: string[];
	codeMarkers: string[];
	loadedContentHashes: string[];
}

export interface ProblemCardCandidate {
	card: ProblemCard;
	score: number;
	matchedBy: string[];
	variantScores: Array<{
		variant: ProblemCardVariant;
		score: number;
		matchedBy: string[];
	}>;
}

export interface ProblemIdentificationDecision {
	cardId?: string;
	variantId?: string;
	confidence: number;
	evidence: string[];
	reason: string;
	reused: boolean;
}

export interface LoadedProblemCard {
	cardId: string;
	variantId?: string;
	content: string;
	contentHash: string;
}

export interface LoadedProblemCardFacts {
	card: ProblemCardFacts;
	variant?: ProblemCardFacts;
}

export interface ProblemEvidenceInput {
	userText: string;
	workspace: MinimalWorkspaceContext;
	loadedItems: LoadedWorkspaceItem[];
}
