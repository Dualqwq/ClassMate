import { z } from 'zod';

export const requestTypeSchema = z.enum([
	'chat',
	'problem_understanding',
	'problem_hint',
	'concept_explanation',
	'code_explanation',
	'compile_error_help',
	'runtime_error_help',
	'wrong_output_help',
	'oj_failure_help',
	'oop_confusion',
	'mistake_summary',
	'solution_request',
	'code_edit',
	'unclassified',
]);

export const contextModeSchema = z.enum([
	'none',
	'active_file',
	'problem_context',
	'debug_context',
	'edit_context',
]);

export const contextRequestSchema = z.object({
	source: z.enum(['workspace', 'skill', 'user']),
	target: z.string().trim().min(1).max(500),
	section: z.string().trim().min(1).max(300).optional(),
	required: z.boolean(),
	reason: z.string().trim().min(1).max(500),
}).strict();

export const routerResultSchema = z.object({
	requestType: requestTypeSchema,
	confidence: z.number().min(0).max(1),
	alternativeRequestTypes: z.array(requestTypeSchema).max(5),
	contextRequests: z.array(contextRequestSchema).max(10),
	reason: z.string().trim().min(1).max(1000),
}).strict();

const skillPurposeSchema = z.enum([
	'definition',
	'example',
	'debug',
	'misconception',
	'prerequisite',
	'response_pattern',
]);

export const skillRetrievalQuerySchema = z.object({
	requestType: requestTypeSchema,
	concepts: z.array(z.string().trim().min(1).max(100)).max(12),
	purposes: z.array(skillPurposeSchema).max(6),
	learnerLevel: z.enum(['beginner', 'intermediate', 'unknown']),
	hintLevel: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
	maxSections: z.number().int().min(1).max(5),
	maxTokens: z.number().int().min(200).max(4000),
}).strict();

export const answerPlanSchema = z.object({
	requestType: requestTypeSchema,
	depthLevel: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
	responsePattern: z.array(z.string().trim().min(1).max(300)).min(1).max(8),
	mustInclude: z.array(z.string().trim().min(1).max(300)).max(10),
	mustAvoid: z.array(z.string().trim().min(1).max(300)).max(10),
	allowCompleteCode: z.boolean(),
	skillQuery: skillRetrievalQuerySchema,
}).strict();

export const plannerResultSchema = z.object({
	answerPlan: answerPlanSchema,
	skillRetrievalQuery: skillRetrievalQuerySchema,
}).strict();

const compactAnswerPlanSchema = z.object({
	depthLevel: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
	responsePattern: z.array(z.string().trim().min(1).max(300)).min(1).max(8),
	mustInclude: z.array(z.string().trim().min(1).max(300)).max(10),
	mustAvoid: z.array(z.string().trim().min(1).max(300)).max(10),
	allowCompleteCode: z.boolean(),
}).strict();

const compactSkillRetrievalQuerySchema = z.object({
	concepts: z.array(z.string().trim().min(1).max(100)).max(12),
	purposes: z.array(skillPurposeSchema).max(6),
	maxSections: z.number().int().min(1).max(5),
	maxTokens: z.number().int().min(200).max(4000),
}).strict();

export const routeAndPlanResultSchema = z.object({
	requestType: requestTypeSchema,
	contextMode: contextModeSchema,
	confidence: z.number().min(0).max(1),
	isAssignmentWorkspace: z.boolean(),
	assignmentRoot: z.string().trim().min(1).max(500).optional(),
	assignmentEvidence: z.array(z.string().trim().min(1).max(100)).max(6),
	workspaceRequests: z.array(z.object({
		target: z.string().trim().min(1).max(500),
		section: z.string().trim().min(1).max(300).nullish(),
		required: z.boolean(),
		reason: z.string().trim().min(1).max(500),
	}).strict()),
	skillRequests: z.array(z.object({
		id: z.string().trim().regex(/^[a-z0-9][a-z0-9.-]*$/).max(120),
		required: z.boolean(),
		reason: z.string().trim().min(1).max(500),
	}).strict()).max(5),
	answerPlan: compactAnswerPlanSchema,
	skillRetrievalQuery: compactSkillRetrievalQuerySchema,
	reason: z.string().trim().min(1).max(500),
}).strict();

/**
 * Small wire format used for the single RouteAndPlan model call.
 * Defaults and explanatory metadata are rebuilt locally so the model does not
 * spend hundreds of tokens repeating field names and reasons.
 */
export const routeAndPlanWireSchema = z.object({
	t: requestTypeSchema,
	m: contextModeSchema.optional(),
	f: z.array(z.string().trim().min(1).max(500)).max(100).default([]),
	s: z.array(z.string().trim().regex(/^[a-z0-9][a-z0-9.-]*$/).max(120)).max(10).default([]),
	d: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).default(1),
	p: z.array(z.string().trim().min(1).max(100)).min(1).max(10).default(['简要回答']),
	i: z.array(z.string().trim().min(1).max(100)).max(10).default([]),
	a: z.array(z.string().trim().min(1).max(100)).max(10).default([]),
	code: z.boolean().default(false),
	q: z.array(z.string().trim().min(1).max(100)).max(12).default([]),
	u: z.array(skillPurposeSchema).max(6).default([]),
	w: z.boolean().default(false),
	r: z.string().trim().min(1).max(500).nullish(),
	e: z.array(z.string().trim().min(1).max(100)).max(6).default([]),
}).strict();

export const answerValidationResultSchema = z.object({
	valid: z.boolean(),
	problems: z.array(z.string().trim().min(1).max(500)).max(10),
	shouldRegenerate: z.boolean(),
}).strict();

export function parseJsonObject(text: string): unknown {
	const trimmed = text.trim();
	try {
		return JSON.parse(trimmed);
	} catch {
		const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
		if (fenced?.[1]) {
			return JSON.parse(fenced[1].trim());
		}
		const start = trimmed.indexOf('{');
		const end = trimmed.lastIndexOf('}');
		if (start >= 0 && end > start) {
			return JSON.parse(trimmed.slice(start, end + 1));
		}
		throw new Error('Model output does not contain a valid JSON object.');
	}
}
