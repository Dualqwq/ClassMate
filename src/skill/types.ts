import type { RequestType } from '../graph/types';

export type LearnerLevel = 'beginner' | 'intermediate' | 'unknown';

export type SkillPurpose =
	| 'definition'
	| 'example'
	| 'debug'
	| 'misconception'
	| 'prerequisite'
	| 'response_pattern';

export type SkillRelationType =
	| 'prerequisite'
	| 'next_concept'
	| 'confused_with'
	| 'has_misconception'
	| 'has_example'
	| 'used_for_debugging'
	| 'response_pattern'
	| 'explains';

export interface SkillNodeSource {
	path: string;
	headingPath: string[];
}

export interface SkillRelation {
	type: SkillRelationType;
	target: string;
}

export interface SkillNode {
	id: string;
	title: string;
	source: SkillNodeSource;
	concepts: string[];
	aliases: string[];
	requestTypes: RequestType[];
	purposes: SkillPurpose[];
	learnerLevels: LearnerLevel[];
	relations: SkillRelation[];
}

export interface SkillGraph {
	schemaVersion: number;
	graphVersion: string;
	nodes: SkillNode[];
}

export interface SkillCandidate {
	node: SkillNode;
	score: number;
	matchedBy: string[];
	relationsUsed: string[];
}

export interface RetrievedSkillSection {
	nodeId: string;
	path: string;
	headingPath: string[];
	content: string;
	score: number;
	matchedBy: string[];
	relationsUsed: string[];
	contentHash: string;
	truncated?: boolean;
}
