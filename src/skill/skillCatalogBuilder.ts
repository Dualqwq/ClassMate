import type { SkillGraph } from './types';

export interface CompactSkillCatalogEntry {
	id: string;
	title: string;
	path: string;
	heading: string;
	tags: string[];
	purposes: string[];
}

export interface CompactSkillCatalog {
	version: string;
	sections: CompactSkillCatalogEntry[];
}

/**
 * 把包含关系边和大量内部字段的 Skill Graph 压缩成模型可读目录。
 * 目录包含全部节点，但不包含正文和关系边，避免把整个 skill-graph.json
 * 提交给规划模型。稳定 ID 供模型选择，路径仍由运行时二次校验。
 */
export function buildCompactSkillCatalog(graph: SkillGraph): CompactSkillCatalog {
	return {
		version: graph.graphVersion,
		sections: graph.nodes.map((node) => ({
			id: node.id,
			title: node.title,
			path: node.source.path,
			heading: node.source.headingPath.join(' > '),
			tags: [...new Set([...node.concepts, ...node.aliases])].slice(0, 12),
			purposes: [...node.purposes],
		})),
	};
}
