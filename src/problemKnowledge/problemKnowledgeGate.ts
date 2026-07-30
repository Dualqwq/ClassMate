import type { ProblemCard, ProblemRecognitionEvidence } from './types';

const COURSE_OR_ASSIGNMENT_PATTERN =
	/(数据结构|data\s*structure|\bcst\b|\bpa[1-4]\b|\blab[1-4]\b|\b[1-4][.-][1-3][.-][1-3]\b|\b(?:9489|9490|9491|9492|9493|9513|9669|9672|9505|9508|9511|9495|9760|9763|9764|9525)\b)/i;
const DATA_STRUCTURE_PROBLEM_PATTERN =
	/(单调队列|双向链表|折半搜索|meet.in.the.middle|splay|伸展树|kd\s*树|kd\s*tree|动态线段树|并查集|左式堆|dijkstra|二维哈希|二维偏序|中缀.*后缀|祖玛|zuma|最近邻|模式匹配|连通块|每份礼物.*两个价格|总价.*(?:选法|方案))/i;
const SOCIAL_ONLY_PATTERN =
	/^(你好|您好|谢谢|感谢|再见|你是谁|hello|hi|thanks|thank you)[！!。.？?\s]*$/i;
const ASSIGNMENT_HELP_PATTERN =
	/(这题|题目|作业|没思路|不知道|怎么(?:做|写|想|处理|维护|开始)|复杂度|超时|答案|样例|提交|\b(?:wa|tle|re|oj)\b)/i;

function normalizeIdentity(value: string): string {
	return value
		.toLocaleLowerCase()
		.replace(/[_.\s/\\()[\]（）【】\-]+/g, '');
}

export interface ProblemKnowledgeGateResult {
	shouldIdentify: boolean;
	reasons: string[];
}

export function assessProblemKnowledgeGate(
	evidence: ProblemRecognitionEvidence,
	knownCards: ProblemCard[] = []
): ProblemKnowledgeGateResult {
	if (SOCIAL_ONLY_PATTERN.test(evidence.userText.trim())) {
		return { shouldIdentify: false, reasons: ['pure-social-message'] };
	}
	const pathText = [
		evidence.activeFile ?? '',
		evidence.questionFile ?? '',
		...evidence.workspacePaths,
	].join('\n');
	const contentText = [
		evidence.userText,
		...evidence.questionSnippets,
		...evidence.codeMarkers,
	].join('\n');
	const reasons: string[] = [];
	if (COURSE_OR_ASSIGNMENT_PATTERN.test(pathText)) {
		reasons.push('workspace-course-or-assignment-signal');
	}
	if (COURSE_OR_ASSIGNMENT_PATTERN.test(contentText)) {
		reasons.push('question-number-or-course-signal');
	}
	if (DATA_STRUCTURE_PROBLEM_PATTERN.test(contentText)) {
		reasons.push('data-structure-problem-signal');
	}
	const normalizedContent = normalizeIdentity(contentText);
	const asksQuestion = /[?？]/.test(contentText);
	const hasAssignmentHelpLanguage = ASSIGNMENT_HELP_PATTERN.test(contentText);
	const matchesIndexedIdentity = knownCards.some((card) => {
		const strongIdentities = [card.number, ...card.ojIds, ...card.aliases]
			.map(normalizeIdentity)
			.filter((identity) => identity.length >= 4);
		const title = normalizeIdentity(card.title);
		const hasStrongIdentity = strongIdentities.some((identity) =>
			normalizedContent.includes(identity));
		const hasTitle = title.length >= 4 && normalizedContent.includes(title);
		return (
			(hasStrongIdentity && (asksQuestion || hasAssignmentHelpLanguage))
			|| (hasTitle && (hasAssignmentHelpLanguage || (title.length >= 5 && asksQuestion)))
		);
	});
	if (matchesIndexedIdentity) {
		reasons.push('indexed-problem-identity-signal');
	}
	return {
		shouldIdentify: reasons.length > 0,
		reasons,
	};
}
