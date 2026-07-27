export interface MarkdownSection {
	headingPath: string[];
	content: string;
	startLine: number;
	endLine: number;
}
interface Heading {
	level: number;
	title: string;
	lineIndex: number;
	path: string[];
}

function normalizeHeading(title: string): string {
	return title
		.replace(/\s+#+\s*$/, '')
		.replace(/\s+/g, ' ')
		.trim();
}

function collectHeadings(lines: string[]): Heading[] {
	const headings: Heading[] = [];
	const stack: Array<{ level: number; title: string }> = [];
	let fence: { marker: '`' | '~'; length: number } | undefined;

	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
		if (fenceMatch) {
			const marker = fenceMatch[1][0] as '`' | '~';
			const length = fenceMatch[1].length;
			if (!fence) {
				fence = { marker, length };
			} else if (fence.marker === marker && length >= fence.length) {
				fence = undefined;
			}
			continue;
		}
		if (fence) {
			continue;
		}

		const match = line.match(/^(#{1,6})\s+(.+?)\s*$/);
		if (!match) {
			continue;
		}
		const level = match[1].length;
		const title = normalizeHeading(match[2]);
		while (stack.length > 0 && stack[stack.length - 1].level >= level) {
			stack.pop();
		}
		stack.push({ level, title });
		headings.push({
			level,
			title,
			lineIndex: index,
			path: stack.map((item) => item.title),
		});
	}

	return headings;
}

function pathMatches(actual: string[], requested: string[]): boolean {
	if (requested.length > actual.length) {
		return false;
	}
	const offset = actual.length - requested.length;
	return requested.every((part, index) => actual[offset + index] === normalizeHeading(part));
}

export function extractMarkdownSection(markdown: string, headingPath: string[]): MarkdownSection {
	if (headingPath.length === 0 || headingPath.some((part) => part.trim().length === 0)) {
		throw new Error('headingPath must contain at least one non-empty heading.');
	}

	const lines = markdown.replace(/\r\n/g, '\n').split('\n');
	const headings = collectHeadings(lines);
	const matches = headings.filter((heading) => pathMatches(heading.path, headingPath));

	if (matches.length === 0) {
		throw new Error(`Markdown heading not found: ${headingPath.join(' > ')}`);
	}
	if (matches.length > 1) {
		throw new Error(`Markdown heading is ambiguous: ${headingPath.join(' > ')}`);
	}

	const target = matches[0];
	const nextBoundary = headings.find(
		(heading) => heading.lineIndex > target.lineIndex && heading.level <= target.level
	);
	const contentStart = target.lineIndex + 1;
	const contentEnd = nextBoundary?.lineIndex ?? lines.length;
	const content = lines.slice(contentStart, contentEnd).join('\n').trim();

	if (content.length === 0) {
		throw new Error(`Markdown section is empty: ${headingPath.join(' > ')}`);
	}

	return {
		headingPath: [...headingPath],
		content,
		startLine: contentStart + 1,
		endLine: contentEnd,
	};
}
