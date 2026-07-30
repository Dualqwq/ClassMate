import { extractMarkdownSection } from '../skill/markdownSectionExtractor';
import {
	hashContent,
	isMarkdownReferencePath,
	SkillContentLoader,
} from '../skill/skillContentLoader';
import type {
	LoadedProblemCard,
	ProblemCard,
	ProblemCardVariant,
} from './types';

const MAX_PROBLEM_CARD_CHARS = 12_000;

export class ProblemCardExtractor {
	constructor(private readonly _loader: SkillContentLoader) {}

	public async extract(
		card: ProblemCard,
		variant?: ProblemCardVariant
	): Promise<LoadedProblemCard> {
		const sections = [
			await this._extractSource(card.source.path, card.source.headingPath),
		];
		if (variant) {
			sections.push(
				await this._extractSource(variant.source.path, variant.source.headingPath)
			);
		}
		const joined = sections.join('\n\n').slice(0, MAX_PROBLEM_CARD_CHARS);
		return {
			cardId: card.id,
			variantId: variant?.id,
			content: joined,
			contentHash: hashContent(joined),
		};
	}

	private async _extractSource(path: string, headingPath: string[]): Promise<string> {
		if (!isMarkdownReferencePath(path)) {
			throw new Error(`Disallowed problem card source path: ${path}`);
		}
		const markdown = await this._loader.loadText(path);
		return extractMarkdownSection(markdown, headingPath).content;
	}
}
