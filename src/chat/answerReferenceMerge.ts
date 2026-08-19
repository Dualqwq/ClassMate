import type { ChatReference } from './types';

/**
 * 引用兜底合并(7.6 收尾,用户拍板 2026-08-19):extract_references
 * 一律调用,但只补模型没有提到的部分;提取结果与模型 Answer 引用冲突时
 * 一律以模型为准;严防二次引用(同一符号不因两家来源产生重复链接)。
 *
 * 重合判定(任一命中即视为"模型已提及",提取版丢弃):
 * - 符号级:symbol 相同(含一方无行号的类型引用);
 * - 行级:uri + startLine 相同。
 */
export function mergeContractAndExtractedReferences(
	contract: ChatReference[],
	extracted: ChatReference[]
): ChatReference[] {
	const contractSymbols = new Set(
		contract.map((item) => item.symbol).filter((symbol): symbol is string => Boolean(symbol))
	);
	const contractLines = new Set(
		contract
			.filter((item) => item.startLine !== undefined)
			.map((item) => `${item.uri}|${item.startLine}`)
	);
	const merged: ChatReference[] = [...contract];
	const seenSymbols = new Set(contractSymbols);
	const seenLines = new Set(contractLines);
	for (const candidate of extracted) {
		if (candidate.symbol && seenSymbols.has(candidate.symbol)) {
			continue; // 模型已提及(或提取内部重复):以先到者为准
		}
		if (candidate.startLine !== undefined) {
			const lineKey = `${candidate.uri}|${candidate.startLine}`;
			if (seenLines.has(lineKey)) {
				continue; // 行级重合:模型正文已链到该行
			}
			seenLines.add(lineKey);
		}
		if (candidate.symbol) {
			seenSymbols.add(candidate.symbol);
		}
		merged.push(candidate);
	}
	return merged;
}
