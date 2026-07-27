import type { RetrievedSkillSection, SkillCandidate } from './types';
import { extractMarkdownSection } from './markdownSectionExtractor';
import {
	hashContent,
	isMarkdownReferencePath,
	SkillContentLoader,
} from './skillContentLoader';

export class SkillSectionExtractor {
	constructor(private readonly _loader: SkillContentLoader) {}

	public async extract(candidate: SkillCandidate): Promise<RetrievedSkillSection> {
		const source = candidate.node.source;
		if (!isMarkdownReferencePath(source.path)) {
			throw new Error(`Disallowed Skill source path: ${source.path}`);
		}
		const markdown = await this._loader.loadText(source.path);
		const section = extractMarkdownSection(markdown, source.headingPath);
		return {
			nodeId: candidate.node.id,
			path: source.path,
			headingPath: source.headingPath,
			content: section.content,
			score: candidate.score,
			matchedBy: candidate.matchedBy,
			relationsUsed: candidate.relationsUsed,
			contentHash: hashContent(section.content),
		};
	}

	public async extractAll(candidates: SkillCandidate[]): Promise<RetrievedSkillSection[]> {
		const results = await Promise.allSettled(candidates.map((candidate) => this.extract(candidate)));
		return results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
	}
}
