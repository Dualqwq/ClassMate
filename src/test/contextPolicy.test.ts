import * as assert from 'assert';
import { describe, it } from 'mocha';
import {
	biasRequestTypeForWorkspace,
	inferContextMode,
	selectAssignmentFallbackRequests,
	selectFirstCallWorkspaceRequests,
	selectWorkspaceContextRequests,
} from '../workspace/contextPolicy';
import type { MinimalWorkspaceContext, WorkspaceFileEntry } from '../workspace/types';

function entry(
	filePath: string,
	kind: WorkspaceFileEntry['kind']
): WorkspaceFileEntry {
	return {
		path: filePath,
		uri: `file:///${filePath}`,
		kind,
		size: 100,
		modifiedAt: 1,
	};
}

function assignmentWorkspace(): MinimalWorkspaceContext {
	const files: WorkspaceFileEntry[] = [
		entry('assignment/question.md', 'question'),
		entry('assignment/main.cpp', 'code'),
		entry('assignment/Editor.h', 'code'),
		entry('assignment/Editor.cpp', 'code'),
		entry('assignment/TextProcessor.h', 'code'),
		entry('assignment/TextProcessor.cpp', 'code'),
		entry('assignment/Makefile', 'build'),
		entry('assignment/tests/sample.txt', 'text'),
		entry('other-assignment/question.md', 'question'),
		entry('other-assignment/main.cpp', 'code'),
	];
	return {
		catalog: {
			files,
			questionFiles: [
				'assignment/question.md',
				'other-assignment/question.md',
			],
			activeEditor: {
				fileName: 'assignment/main.cpp',
				uri: 'file:///assignment/main.cpp',
				languageId: 'cpp',
			},
		},
		questionFile: 'assignment/question.md',
	};
}

describe('V5 workspace context policy', () => {
	it('loads every supported file in the current problem directory without a count cap', () => {
		const workspace = assignmentWorkspace();
		const requests = selectWorkspaceContextRequests({
			requestType: 'problem_hint',
			contextMode: 'problem_context',
			workspace,
			userText: '这题下一步怎么写？',
			modelRequests: [],
			explicitRequests: [],
		});
		const paths = requests.map((request) => request.target);

		assert.strictEqual(paths.length, 8);
		assert.ok(paths.includes('assignment/question.md'));
		assert.ok(paths.includes('assignment/TextProcessor.cpp'));
		assert.ok(paths.includes('assignment/Makefile'));
		assert.ok(paths.includes('assignment/tests/sample.txt'));
		assert.ok(!paths.some((filePath) => filePath.startsWith('other-assignment/')));
	});

	it('biases an ambiguous assignment follow-up toward problem_hint', () => {
		const workspace = assignmentWorkspace();
		assert.strictEqual(
			biasRequestTypeForWorkspace('chat', '那我下一步应该怎么写？', workspace),
			'problem_hint'
		);
		assert.strictEqual(
			inferContextMode('problem_hint', workspace, '那我下一步应该怎么写？'),
			'problem_context'
		);
	});

	it('keeps pure social conversation as chat even inside an assignment workspace', () => {
		const workspace = assignmentWorkspace();
		assert.strictEqual(
			biasRequestTypeForWorkspace('chat', '谢谢', workspace),
			'chat'
		);
		assert.strictEqual(inferContextMode('chat', workspace, '谢谢'), 'none');
	});

	it('keeps the previous assignment type for a short follow-up', () => {
		const workspace = assignmentWorkspace();
		assert.strictEqual(
			biasRequestTypeForWorkspace('chat', '那这里为什么不对？', workspace, {
				problemRoot: 'assignment',
				questionPath: 'assignment/question.md',
				activeSourcePath: 'assignment/main.cpp',
				relatedPaths: ['assignment/question.md', 'assignment/main.cpp'],
				previousRequestType: 'wrong_output_help',
				previousContextMode: 'debug_context',
			}),
			'wrong_output_help'
		);
	});

	it('does not inherit solution_request across turns; it falls back to problem_hint', () => {
		const workspace = assignmentWorkspace();
		assert.strictEqual(
			biasRequestTypeForWorkspace('chat', '然后呢', workspace, {
				problemRoot: 'assignment',
				questionPath: 'assignment/question.md',
				activeSourcePath: 'assignment/main.cpp',
				relatedPaths: ['assignment/question.md', 'assignment/main.cpp'],
				previousRequestType: 'solution_request',
				previousContextMode: 'problem_context',
			}),
			'problem_hint'
		);
	});

	it('keeps previous assignment context for a natural follow-up without keywords', () => {
		const workspace = assignmentWorkspace();
		const previous = {
			problemRoot: 'assignment',
			questionPath: 'assignment/question.md',
			activeSourcePath: 'assignment/main.cpp',
			relatedPaths: ['assignment/question.md', 'assignment/main.cpp'],
			previousRequestType: 'wrong_output_help' as const,
			previousContextMode: 'debug_context' as const,
			isAssignmentWorkspace: true,
		};
		assert.strictEqual(
			biasRequestTypeForWorkspace('chat', '我改完还是一样', workspace, previous),
			'wrong_output_help'
		);
		assert.strictEqual(
			inferContextMode('chat', workspace, '我改完还是一样', previous),
			'debug_context'
		);
	});

	it('always includes the nearest problem statement even when context mode is none', () => {
		const requests = selectWorkspaceContextRequests({
			requestType: 'chat',
			contextMode: 'none',
			workspace: assignmentWorkspace(),
			userText: '帮我看看',
			modelRequests: [],
			explicitRequests: [],
		});
		const question = requests.find(
			(request) => request.target === 'assignment/question.md'
		);
		assert.strictEqual(question?.required, true);
	});

	it('includes all files from a small assignment scope in the first model call', () => {
		const requests = selectFirstCallWorkspaceRequests(assignmentWorkspace());
		const paths = requests.map((request) => request.target);
		assert.strictEqual(paths.length, 8);
		assert.ok(paths.includes('assignment/question.md'));
		assert.ok(paths.includes('assignment/main.cpp'));
		assert.ok(!paths.includes('other-assignment/main.cpp'));
	});

	it('includes a whole small workspace even when no editor or question is selected', () => {
		const workspace: MinimalWorkspaceContext = {
			catalog: {
				files: [
					entry('main.cpp', 'code'),
					entry('README.md', 'text'),
					entry('Makefile', 'build'),
				],
				questionFiles: [],
			},
		};
		const paths = selectFirstCallWorkspaceRequests(workspace)
			.map((request) => request.target);
		assert.deepStrictEqual(
			new Set(paths),
			new Set(['main.cpp', 'README.md', 'Makefile'])
		);
	});

	it('uses the small active directory when the wider assignment exceeds 20 files', () => {
		const files: WorkspaceFileEntry[] = [
			entry('course/question.md', 'question'),
			entry('course/task/main.cpp', 'code'),
			entry('course/task/helper.h', 'code'),
			...Array.from({ length: 21 }, (_, index) =>
				entry(`course/library/file-${index}.cpp`, 'code')),
		];
		const workspace: MinimalWorkspaceContext = {
			catalog: {
				files,
				questionFiles: ['course/question.md'],
				activeEditor: {
					fileName: 'course/task/main.cpp',
					uri: 'file:///course/task/main.cpp',
					languageId: 'cpp',
				},
			},
			questionFile: 'course/question.md',
		};
		const paths = selectFirstCallWorkspaceRequests(workspace)
			.map((request) => request.target);

		assert.deepStrictEqual(
			new Set(paths),
			new Set([
				'course/question.md',
				'course/task/main.cpp',
				'course/task/helper.h',
			])
		);
	});

	it('falls back to assignment files when normal loading selected nothing', () => {
		const requests = selectAssignmentFallbackRequests(assignmentWorkspace());
		const paths = requests.map((request) => request.target);
		assert.ok(paths.includes('assignment/question.md'));
		assert.ok(paths.includes('assignment/main.cpp'));
		assert.ok(requests.every((request) => request.required === false));
	});
});
