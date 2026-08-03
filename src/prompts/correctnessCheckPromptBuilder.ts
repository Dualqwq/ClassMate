import type { LLMMessage } from '../llm/types';
import type { AnswerPlan, ProblemConstraints } from '../graph/types';
import type { LoadedProblemCardFacts } from '../problemKnowledge/types';

export interface CorrectnessCheckPromptInput {
	userText: string;
	candidateAnswer: string;
	answerPlan: AnswerPlan;
	constraints: ProblemConstraints;
	problemCardFacts?: LoadedProblemCardFacts;
	allowCorrection: boolean;
}

export class CorrectnessCheckPromptBuilder {
	public build(input: CorrectnessCheckPromptInput): LLMMessage[] {
		return [
			{
				role: 'system',
				content: [
					'=== ClassMate Lightweight Correctness Check ===',
					'Check the candidate answer against the frozen constraints. Do not reward writing style and do not introduce new unsupported facts.',
					'Check especially: ignored hard constraints; algorithm applicability and complexity; arithmetic consistency; whether examples or counterexamples actually support the conclusion; invented classes, members, signatures, files, or code behavior; and completeness when full code was requested.',
					'For graph or numeric examples, recompute every stated weight, distance, index, and output before passing.',
					'Claims not supported by constraints or verified facts must be labeled as hypotheses in the student answer.',
					'Return JSON only with this exact short contract:',
					'{"p":boolean,"s":"none|minor|major","i":[{"c":"category","d":"problem","f":"required correction"}],"a":"optional complete corrected student-facing answer"}',
					'Allowed categories: constraint_ignored, wrong_algorithm, invalid_example, arithmetic_inconsistency, unsupported_claim, invented_interface, code_answer_mismatch, incomplete_solution, other.',
					'If p is true, use s="none", i=[], and omit a.',
					input.allowCorrection
						? 'If p is false, include a complete corrected answer in a. Preserve the requested beginner level, answer depth, and code policy.'
						: 'Do not rewrite the answer in this attempt; omit a and only report precise issues.',
				].join('\n'),
			},
			{
				role: 'user',
				content: JSON.stringify({
					question: input.userText,
					constraints: input.constraints,
					verifiedProblemFacts: input.problemCardFacts,
					answerPlan: {
						requestType: input.answerPlan.requestType,
						depthLevel: input.answerPlan.depthLevel,
						mustInclude: input.answerPlan.mustInclude,
						mustAvoid: input.answerPlan.mustAvoid,
						allowCompleteCode: input.answerPlan.allowCompleteCode,
					},
					candidateAnswer: input.candidateAnswer,
				}),
			},
		];
	}
}

