import * as assert from 'assert';
import { describe, it } from 'mocha';
import { AnswerPromptBuilder } from '../prompts/answerPromptBuilder';

describe('Answer prompt source-grounding safeguards', () => {
	it('requires the model to analyze loaded source instead of inventing generic code', () => {
		const messages = new AnswerPromptBuilder().build({
			skillCore: 'skill',
			pedagogy: 'pedagogy',
			answerPlan: {
				requestType: 'runtime_error_help',
				depthLevel: 1,
				responsePattern: ['location', 'reason'],
				mustInclude: [],
				mustAvoid: ['complete code'],
				allowCompleteCode: false,
				skillQuery: {
					requestType: 'runtime_error_help',
					concepts: ['linked list'],
					purposes: ['debug'],
					learnerLevel: 'beginner',
					hintLevel: 1,
					maxSections: 1,
					maxTokens: 500,
				},
			},
			assembledSkillContext: 'linked-list guidance',
			assembledProblemCardContext: 'matched diagnostic card',
			problemCardFacts: {
				card: {
					id: 'ds.lab2.zuma',
					kind: 'solution',
					primaryConclusion: 'Use a locally modifiable sequence.',
					evidence: ['Chain reactions are possible.'],
					pitfalls: [],
					verifiedTests: [],
					rejectedClaims: [],
					answerRequirements: ['Verify the current code.'],
				},
				variant: {
					id: 'ds.lab2.zuma.bug-03-linear-insert',
					kind: 'diagnostic',
					primaryConclusion: 'Middle string insert and erase cause O(mn) time.',
					evidence: ['Each middle update moves later characters.'],
					complexity: { time: 'O(mn)', space: 'O(n)' },
					pitfalls: ['An outer index does not remove string movement.'],
					verifiedTests: [],
					rejectedClaims: ['The rank points to the old character.'],
					answerRequirements: ['Lead with the complexity bottleneck.'],
				},
			},
			problemCardMatch: {
				cardId: 'ds.lab2.zuma',
				variantId: 'ds.lab2.zuma.bug-03-linear-insert',
				confidence: 0.99,
				evidence: ['Exact indexed content hash matched.'],
			},
			workspaceSnapshot: {
				snapshotId: 'snapshot',
				createdAt: 1,
				minimal: {
					catalog: { files: [], questionFiles: [] },
					activeFilePreview: 'UNPLANNED_ACTIVE_PREVIEW',
					questionText: 'UNPLANNED_QUESTION_BODY',
				},
				loadedItems: [{
					path: 'task_list.cpp',
					kind: 'code',
					content: 'while (n != index) { n++; current = current->next; }',
					contentHash: 'hash',
					reason: 'user named this file',
				}],
			},
			userText: 'Why does at(-1) loop forever?',
			conversationHistory: [],
		});

		const prompt = messages.map((message) => message.content).join('\n');
		assert.match(prompt, /analyze that exact source code/);
		assert.match(prompt, /Do not replace it with a generic example/);
		assert.match(messages[0].content, /name the exact file you need to see/);
		assert.match(messages[0].content, /never invent its contents/);
		assert.match(prompt, /Exact snapshot diagnostic requirement/);
		assert.match(prompt, /make that variant the primary diagnosis/);
		assert.match(prompt, /Structured verified facts/);
		assert.match(prompt, /Middle string insert and erase cause O\(mn\) time/);
		assert.match(
			prompt,
			/has no verifiedTests entry\. Do not invent a concrete input/
		);
		assert.match(prompt, /while \(n != index\)/);
		assert.match(prompt, /skill/);
		assert.doesNotMatch(prompt, /UNPLANNED_ACTIVE_PREVIEW/);
		assert.doesNotMatch(prompt, /UNPLANNED_QUESTION_BODY/);
	});

	it('orders messages stable-first so the DeepSeek prefix cache stays long', () => {
		const messages = new AnswerPromptBuilder().build({
			skillCore: 'skill',
			pedagogy: 'pedagogy',
			answerPlan: {
				requestType: 'concept_explanation',
				depthLevel: 2,
				responsePattern: ['definition', 'example'],
				mustInclude: [],
				mustAvoid: [],
				allowCompleteCode: false,
				skillQuery: {
					requestType: 'concept_explanation',
					concepts: ['pointer'],
					purposes: ['debug'],
					learnerLevel: 'beginner',
					hintLevel: 2,
					maxSections: 1,
					maxTokens: 500,
				},
			},
			assembledSkillContext: 'pointer guidance',
			workspaceSnapshot: {
				snapshotId: 'snap-1',
				createdAt: 1,
				minimal: {
					catalog: { files: [], questionFiles: [] },
					activeFilePreview: 'UNPLANNED_ACTIVE_PREVIEW',
					questionText: 'UNPLANNED_QUESTION_BODY',
				},
				loadedItems: [{
					path: 'main.cpp',
					kind: 'code',
					content: 'int main() { return 0; }',
					contentHash: 'hash',
					reason: 'active',
				}],
			},
			userText: 'What is a pointer?',
			conversationHistory: [],
		});

		assert.match(messages[0].content, /=== ClassMate Answer Mode ===/);
		assert.match(messages[1].content, /=== Frozen workspace data ===/);
		assert.match(messages[2].content, /=== Selected Skill Context ===/);
		assert.match(messages[3].content, /=== Imported courseware context ===/);
		assert.match(messages[4].content, /=== Answer plan ===/);
		assert.strictEqual(messages[messages.length - 1].content, 'What is a pointer?');
		assert.ok(messages.length >= 6, 'expected a stable prefix, courseware context, snapshot, plan and user message');
		const snapshot = messages[1].content;
		assert.match(snapshot, /=== Loaded files \(1-based line numbers\) ===/);
		assert.match(snapshot, /=== Files present in the workspace but not loaded ===/);
		assert.match(snapshot, /\n   1 \| int main\(\) \{ return 0; \}/);
	});

	it('puts volatile snapshot fields after the stable file-content part', () => {
		const messages = new AnswerPromptBuilder().build({
			skillCore: 'skill',
			pedagogy: 'pedagogy',
			answerPlan: {
				requestType: 'concept_explanation',
				depthLevel: 2,
				responsePattern: ['definition', 'example'],
				mustInclude: [],
				mustAvoid: [],
				allowCompleteCode: false,
				skillQuery: {
					requestType: 'concept_explanation',
					concepts: ['pointer'],
					purposes: ['debug'],
					learnerLevel: 'beginner',
					hintLevel: 2,
					maxSections: 1,
					maxTokens: 500,
				},
			},
			assembledSkillContext: 'pointer guidance',
			workspaceSnapshot: {
				snapshotId: 'snap-1',
				createdAt: 1,
				minimal: {
					catalog: { files: [], questionFiles: [] },
					activeFilePreview: 'UNPLANNED_ACTIVE_PREVIEW',
					questionText: 'UNPLANNED_QUESTION_BODY',
				},
				loadedItems: [{
					path: 'main.cpp',
					kind: 'code',
					content: 'int main() { return 0; }',
					contentHash: 'hash',
					reason: 'active',
				}],
			},
			userText: 'What is a pointer?',
			conversationHistory: [],
		});

		const snapshot = messages[1].content;
		const loadedIndex = snapshot.indexOf('=== Loaded files (1-based line numbers) ===');
		const snapshotIdIndex = snapshot.indexOf('"snapshotId"');
		assert.ok(loadedIndex >= 0 && loadedIndex < snapshotIdIndex, 'loaded files must precede snapshotId');
	});

	it('sorts snapshot loadedItems by path and keeps reason after contentHash', () => {
		const messages = new AnswerPromptBuilder().build({
			skillCore: 'skill',
			pedagogy: 'pedagogy',
			answerPlan: {
				requestType: 'concept_explanation',
				depthLevel: 2,
				responsePattern: ['definition', 'example'],
				mustInclude: [],
				mustAvoid: [],
				allowCompleteCode: false,
				skillQuery: {
					requestType: 'concept_explanation',
					concepts: ['pointer'],
					purposes: ['debug'],
					learnerLevel: 'beginner',
					hintLevel: 2,
					maxSections: 1,
					maxTokens: 500,
				},
			},
			assembledSkillContext: 'pointer guidance',
			workspaceSnapshot: {
				snapshotId: 'snap-1',
				createdAt: 1,
				minimal: {
					catalog: { files: [], questionFiles: [] },
					activeFilePreview: 'UNPLANNED_ACTIVE_PREVIEW',
					questionText: 'UNPLANNED_QUESTION_BODY',
				},
				loadedItems: [
					{
						path: 'z_later.cpp',
						kind: 'code',
						content: 'int z() { return 0; }',
						contentHash: 'z-hash',
						reason: 'route selected this file',
					},
					{
						path: 'a_early.cpp',
						kind: 'code',
						content: 'int a() { return 1; }',
						contentHash: 'a-hash',
						reason: 'user named this file',
					},
				],
			},
			userText: 'What is a pointer?',
			conversationHistory: [],
		});

		const snapshot = messages[1].content;
		const aIndex = snapshot.indexOf('a_early.cpp');
		const zIndex = snapshot.indexOf('z_later.cpp');
		assert.ok(aIndex >= 0 && aIndex < zIndex, 'loadedItems must be sorted by path');
		const itemStart = snapshot.indexOf('"path":"a_early.cpp"');
		const hashIndex = snapshot.indexOf('"contentHash"', itemStart);
		const reasonIndex = snapshot.indexOf('"reason"', itemStart);
		assert.ok(hashIndex >= 0 && hashIndex < reasonIndex, 'reason must come after contentHash');
		assert.match(snapshot, /\n   1 \| int a\(\) \{ return 1; \}/);
	});
});

describe('Answer prompt reference-target contract block', () => {
	function buildWithTargets() {
		return new AnswerPromptBuilder().build({
			skillCore: 'skill',
			pedagogy: 'pedagogy',
			answerPlan: {
				requestType: 'concept_explanation',
				depthLevel: 2,
				responsePattern: ['definition'],
				mustInclude: [],
				mustAvoid: [],
				allowCompleteCode: false,
				skillQuery: {
					requestType: 'concept_explanation',
					concepts: ['class'],
					purposes: ['definition'],
					learnerLevel: 'beginner',
					hintLevel: 2,
					maxSections: 1,
					maxTokens: 500,
				},
			},
			assembledSkillContext: 'class guidance',
			workspaceSnapshot: {
				snapshotId: 'snap-1',
				createdAt: 1,
				minimal: {
					catalog: { files: [], questionFiles: [] },
				},
				loadedItems: [{
					path: 'monster.h',
					kind: 'code',
					content: 'class Monster { void takeTurn() {} };',
					contentHash: 'hash',
					reason: 'active',
				}],
			},
			referenceTargets: [{
				targetId: 'sym:monster.h:Monster:takeTurn',
				file: 'monster.h',
				name: 'takeTurn',
				kind: 'method',
				startLine: 26,
			}],
			userText: 'takeTurn 是干什么的?',
			conversationHistory: [],
		});
	}

	it('requires marking EVERY occurrence of a symbol, not just the first mention', () => {
		const prompt = buildWithTargets().map((message) => message.content).join('\n');
		assert.match(prompt, /EVERY occurrence/);
		assert.doesNotMatch(prompt, /first mention/);
	});

	it('shows an example where the same symbol is marked twice', () => {
		const prompt = buildWithTargets().map((message) => message.content).join('\n');
		const markerRegex = /\{\{ref:sym:monster\.h:Monster:takeTurn\|takeTurn\}\}/g;
		const count = (prompt.match(markerRegex) ?? []).length;
		assert.ok(
			count >= 2,
			`示例必须展示同一符号被标记两次,实际出现 ${count} 次`
		);
	});

	it('stays silent about refblock so the model never learns the syntax', () => {
		const prompt = buildWithTargets().map((message) => message.content).join('\n');
		assert.doesNotMatch(prompt, /refblock/, '提示词不得出现 refblock 字样(不提及即不会生成)');
		assert.doesNotMatch(prompt, /classmate-ref:\/\//, '提示词不得暴露成品链接协议');
	});
});

describe('state-verification history guard (7.8 验证类问题历史不作证据)', () => {
	function buildPrompt(userText: string) {
		const messages = new AnswerPromptBuilder().build({
			skillCore: 'skill',
			pedagogy: 'pedagogy',
			answerPlan: {
				requestType: 'code_explanation',
				depthLevel: 2,
				responsePattern: ['explain'],
				mustInclude: [],
				mustAvoid: [],
				allowCompleteCode: false,
				skillQuery: {
					requestType: 'code_explanation',
					concepts: ['functions'],
					purposes: ['debug'],
					learnerLevel: 'beginner',
					hintLevel: 2,
					maxSections: 1,
					maxTokens: 500,
				},
			},
			assembledSkillContext: 'functions',
			workspaceSnapshot: {
				snapshotId: 'snapshot',
				createdAt: 1,
				minimal: { catalog: { files: [], questionFiles: [] } },
				loadedItems: [],
			} as never,
			userText,
			conversationHistory: [],
		});
		return messages.map((message) => message.content).join('\n');
	}

	it('adds the not-evidence statement for verification questions', () => {
		for (const question of ['takeTurn 现在有几行', '写完了吗', '现在呢']) {
			const prompt = buildPrompt(question);
			assert.ok(
				prompt.includes('NOT evidence'),
				`验证类问题"${question}"必须声明历史状态陈述不是证据`
			);
		}
	});

	it('stays silent for ordinary questions', () => {
		const prompt = buildPrompt('帮我讲讲循环的写法');
		assert.ok(!prompt.includes('NOT evidence'), '普通问题不加声明');
	});
});

describe('solution_request answer-prompt guard (#30)', () => {
	it('includes the no-full-solution instruction for solution_request', () => {
		const messages = new AnswerPromptBuilder().build({
			skillCore: 'skill',
			pedagogy: 'pedagogy',
			answerPlan: {
				requestType: 'solution_request',
				depthLevel: 2,
				responsePattern: ['hint'],
				mustInclude: [],
				mustAvoid: [],
				allowCompleteCode: false,
				skillQuery: {
					requestType: 'solution_request',
					concepts: ['链表'],
					purposes: ['example'],
					learnerLevel: 'beginner',
					hintLevel: 2,
					maxSections: 1,
					maxTokens: 500,
				},
			},
			assembledSkillContext: 'linked-list guidance',
			workspaceSnapshot: {
				snapshotId: 'snap-1',
				createdAt: 1,
				minimal: { catalog: { files: [], questionFiles: [] } },
				loadedItems: [],
			},
			userText: '给我完整代码',
			conversationHistory: [],
		});
		const prompt = messages.map((message) => message.content).join('\n');
		assert.match(prompt, /solution_request/);
		assert.match(prompt, /Do not provide the full program/);
		assert.match(prompt, /keep any illustrative code under 15 non-empty lines/);
	});
});

describe('journey digest injection (#13)', () => {
	const DIGEST_SAMPLE = [
		'=== Student debugging history digest ===',
		'The notes below summarize this student’s recent compile and run history recorded in this workspace.',
		'- main.cpp:12 变量/函数未声明 [编译错误]',
	].join('\n');

	function buildWithDigest(journeyDigestContext?: string) {
		return new AnswerPromptBuilder().build({
			skillCore: 'skill',
			pedagogy: 'pedagogy',
			answerPlan: {
				requestType: 'compile_error_help',
				depthLevel: 1,
				responsePattern: ['location', 'reason'],
				mustInclude: [],
				mustAvoid: [],
				allowCompleteCode: false,
				skillQuery: {
					requestType: 'compile_error_help',
					concepts: ['声明'],
					purposes: ['debug'],
					learnerLevel: 'beginner',
					hintLevel: 1,
					maxSections: 1,
					maxTokens: 500,
				},
			},
			assembledSkillContext: 'declaration guidance',
			workspaceSnapshot: {
				snapshotId: 'snap-1',
				createdAt: 1,
				minimal: { catalog: { files: [], questionFiles: [] } },
				loadedItems: [],
			},
			userText: '这个报错是什么意思',
			conversationHistory: [],
			journeyDigestContext,
		});
	}

	it('有摘要时以独立 system 块注入,位置在课件上下文之后、答案计划之前', () => {
		const messages = buildWithDigest(DIGEST_SAMPLE);
		const digestIndex = messages.findIndex((message) =>
			message.content.includes('Student debugging history digest'));
		const coursewareIndex = messages.findIndex((message) =>
			message.content.includes('Imported courseware context'));
		const planIndex = messages.findIndex((message) =>
			message.content.includes('=== Answer plan ==='));
		assert.ok(digestIndex !== -1, 'digest 块应存在');
		assert.ok(coursewareIndex !== -1 && planIndex !== -1);
		assert.ok(digestIndex > coursewareIndex, '应在课件上下文块之后');
		assert.ok(digestIndex < planIndex, '应在答案计划块之前');
		assert.strictEqual(messages[digestIndex].role, 'system');
		assert.strictEqual(messages[digestIndex].content, DIGEST_SAMPLE);
	});

	it('无摘要(undefined)时不出现占位块', () => {
		const messages = buildWithDigest(undefined);
		const prompt = messages.map((message) => message.content).join('\n');
		assert.doesNotMatch(prompt, /Student debugging history digest/);
	});

	it('空字符串摘要同样完全不注入', () => {
		const messages = buildWithDigest('   ');
		const prompt = messages.map((message) => message.content).join('\n');
		assert.doesNotMatch(prompt, /Student debugging history digest/);
	});
});

describe('review-recap history framing guard (复盘请求不得把当前代码问题包装成历史错题)', () => {
	const DIGEST_SAMPLE = [
		'=== Student debugging history digest ===',
		'The notes below summarize this student’s recent compile and run history recorded in this workspace.',
		'- main.cpp:12 变量/函数未声明 [编译错误]',
	].join('\n');

	function buildPrompt(userText: string, journeyDigestContext?: string) {
		const messages = new AnswerPromptBuilder().build({
			skillCore: 'skill',
			pedagogy: 'pedagogy',
			answerPlan: {
				requestType: 'mistake_summary',
				depthLevel: 2,
				responsePattern: ['summary'],
				mustInclude: [],
				mustAvoid: [],
				allowCompleteCode: false,
				skillQuery: {
					requestType: 'mistake_summary',
					concepts: ['继承'],
					purposes: ['debug'],
					learnerLevel: 'beginner',
					hintLevel: 2,
					maxSections: 1,
					maxTokens: 500,
				},
			},
			assembledSkillContext: 'inheritance guidance',
			workspaceSnapshot: {
				snapshotId: 'snap-1',
				createdAt: 1,
				minimal: { catalog: { files: [], questionFiles: [] } },
				loadedItems: [],
			},
			userText,
			conversationHistory: [],
			journeyDigestContext,
		});
		return messages.map((message) => message.content).join('\n');
	}

	it('复盘措辞命中时注入历史错题锚定约束', () => {
		for (const question of [
			'带我复盘一下我的错题',
			'讲讲我上次错在哪里',
			'我之前犯过的错误有哪些',
			'总结一下我反复出错的地方',
		]) {
			const prompt = buildPrompt(question);
			assert.ok(
				prompt.includes('review or recap their mistakes'),
				`复盘类问题"${question}"必须注入历史错题锚定约束`
			);
			assert.ok(
				prompt.includes('do not claim the student made them before'),
				`复盘类问题"${question}"必须禁止把当前代码问题说成历史错误`
			);
		}
	});

	it('普通提问不注入复盘约束', () => {
		for (const question of [
			'这段代码为什么编译不过',
			'哪里错了',
			'帮我讲讲循环的写法',
			'这个报错是什么意思',
		]) {
			const prompt = buildPrompt(question);
			assert.ok(
				!prompt.includes('review or recap their mistakes'),
				`普通问题"${question}"不得注入复盘约束`
			);
		}
	});

	it('同时命中验证类与复盘类时两个约束块并存', () => {
		const prompt = buildPrompt('我上次错的地方现在还有几行');
		assert.ok(
			prompt.includes('NOT evidence'),
			'验证类声明(HISTORY_NOT_EVIDENCE_STATEMENT)必须同时注入'
		);
		assert.ok(
			prompt.includes('review or recap their mistakes'),
			'复盘类声明(REVIEW_RECAP_GROUNDING_STATEMENT)必须同时注入'
		);
	});

	it('digest 存在与缺席两种形态都注入复盘约束', () => {
		const withDigest = buildPrompt('带我复盘', DIGEST_SAMPLE);
		const withoutDigest = buildPrompt('带我复盘');
		assert.ok(
			withDigest.includes('review or recap their mistakes'),
			'digest 存在时必须注入复盘约束'
		);
		assert.ok(withDigest.includes('Student debugging history digest'));
		assert.ok(
			withoutDigest.includes('there is NO history to cite'),
			'digest 缺席时同样必须注入复盘约束(最需防虚构的场景)'
		);
	});
});
