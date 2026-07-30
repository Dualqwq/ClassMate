import type { RetrievedSkillSection } from './types';

function estimateTokens(text: string): number {
	let cjk = 0;
	let other = 0;
	for (const character of text) {
		if (/[\u3400-\u9fff\uf900-\ufaff]/u.test(character)) {
			cjk++;
		} else {
			other++;
		}
	}
	return cjk + Math.ceil(other / 4);
}

function truncateToTokenBudget(text: string, tokenBudget: number): string {
	const lines = text.split('\n');
	const selected: string[] = [];
	for (const line of lines) {
		const candidate = [...selected, line].join('\n');
		if (estimateTokens(candidate) > tokenBudget) {
			break;
		}
		selected.push(line);
	}
	return selected.join('\n').trim();
}

export interface AssembledSkillContext {
	sections: RetrievedSkillSection[];
	content: string;
	estimatedTokens: number;
}

export function assembleSkillContext(
	sections: RetrievedSkillSection[],
	maxSections: number,
	maxTokens: number
): AssembledSkillContext {
	const unique = new Map<string, RetrievedSkillSection>();
	for (const section of sections) {
		const key = `${section.path}\u0000${section.headingPath.join('>')}\u0000${section.contentHash}`;
		if (!unique.has(key)) {
			unique.set(key, section);
		}
	}

	const selected: RetrievedSkillSection[] = [];
	let usedTokens = 0;
	for (const section of [...unique.values()]
		.sort((a, b) => b.score - a.score || a.nodeId.localeCompare(b.nodeId))) {
		if (selected.length >= Math.max(1, maxSections) || usedTokens >= maxTokens) {
			break;
		}
		const remaining = maxTokens - usedTokens;
		const sectionTokens = estimateTokens(section.content);
		if (sectionTokens <= remaining) {
			selected.push(section);
			usedTokens += sectionTokens;
			continue;
		}
		const truncated = truncateToTokenBudget(section.content, remaining);
		if (truncated.length > 0) {
			selected.push({
				...section,
				content: `${truncated}\n\n[该小节因上下文预算被截断]`,
				truncated: true,
			});
			usedTokens = maxTokens;
		}
	}

	const content = selected.map((section) => [
		`<skill_section id="${section.nodeId}" source="${section.path}" heading="${section.headingPath.join(' > ')}">`,
		section.content,
		'</skill_section>',
	].join('\n')).join('\n\n');

	return {
		sections: selected,
		content,
		estimatedTokens: estimateTokens(content),
	};
}
