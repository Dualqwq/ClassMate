import * as assert from 'assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it } from 'mocha';
import {
	ConversationDiagnosticRecorder,
	parseConversationDiagnosticBundle,
} from '../chat/conversationDiagnostics';

describe('conversation diagnostic recorder', () => {
	it('exports every recorded event and conversation without secrets', async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'classmate-diagnostics-'));
		const journalPath = path.join(directory, 'session.jsonl');
		const outputPath = path.join(directory, 'export.json');
		const recorder = new ConversationDiagnosticRecorder(journalPath, {
			sessionId: 'session-1',
			workspaceId: 'workspace-1',
		});
		const sharedPlan = { requestType: 'code_explanation', depthLevel: 1 };

		recorder.record({
			type: 'turn_started',
			conversationId: 'conversation-1',
			requestId: 'request-1',
			data: {
				userText: '为什么 apiKey 变量为空？',
				config: {
					provider: 'deepseek',
					model: 'deepseek-v4-flash',
					apiKey: 'must-not-leak',
				},
			},
		});
		const previousRecorder = new ConversationDiagnosticRecorder(
			path.join(directory, 'previous-session.jsonl'),
			{ sessionId: 'session-previous', workspaceId: 'workspace-1' }
		);
		previousRecorder.record({
			type: 'turn_completed',
			conversationId: 'conversation-previous',
			requestId: 'request-previous',
			data: { answer: 'previous answer' },
		});
		await previousRecorder.flush();
		recorder.record({
			type: 'graph_node_completed',
			conversationId: 'conversation-1',
			requestId: 'request-1',
			data: {
				node: 'freeze_context',
				state: {
					answerPlan: sharedPlan,
					routeAndPlanResult: { answerPlan: sharedPlan },
					workspaceSnapshot: {
						snapshotId: 'snapshot-1',
						loadedItems: [{ path: 'main.cpp', content: 'int apiKey = 0;' }],
					},
				},
			},
		});

		const bundle = await recorder.exportTo(outputPath, {
			extensionVersion: '0.0.5',
			provider: 'deepseek',
			model: 'deepseek-v4-flash',
			workspaceFolders: ['C:/workspace'],
			activeConversationId: 'conversation-1',
			conversations: [{
				id: 'conversation-1',
				title: 'apiKey 调试',
				createdAt: 1,
				updatedAt: 2,
				inputDraft: '',
				messages: [{
					id: 'message-1',
					role: 'user',
					content: '为什么 apiKey 变量为空？',
					timestamp: 1,
				}],
			}],
		});

		assert.strictEqual(bundle.schemaVersion, 1);
		// 导出范围 = 仅 active 会话:其他会话(previous)的事件被过滤,
		// 即便它们记录在同一个工作区的其他 journal 文件里。
		assert.strictEqual(bundle.events.length, 2);
		assert.deepStrictEqual(
			new Set(bundle.events.map((event) => event.sessionId)),
			new Set(['session-1'])
		);
		assert.ok(bundle.events.every((event) => event.conversationId === 'conversation-1'));
		assert.strictEqual(bundle.conversations.length, 1);
		const completedEvent = bundle.events.find(
			(event) => event.type === 'graph_node_completed'
		);
		assert.ok(completedEvent);
		const completedData = completedEvent.data as {
			state: {
				answerPlan: { requestType: string };
				routeAndPlanResult: { answerPlan: { requestType: string } };
			};
		};
		assert.strictEqual(completedData.state.answerPlan.requestType, 'code_explanation');
		assert.strictEqual(
			completedData.state.routeAndPlanResult.answerPlan.requestType,
			'code_explanation'
		);

		const serialized = await fs.readFile(outputPath, 'utf8');
		assert.ok(!serialized.includes('must-not-leak'));
		assert.ok(!serialized.includes('"apiKey":"must-not-leak"'));
		assert.ok(serialized.includes('int apiKey = 0;'));
		assert.deepStrictEqual(parseConversationDiagnosticBundle(JSON.parse(serialized)), bundle);
	});
});

describe('export scope: active conversation only', () => {
	it('keeps only the active conversation and its events, dropping others and unscoped events', async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'classmate-scope-'));
		const recorder = new ConversationDiagnosticRecorder(
			path.join(directory, 'session.jsonl'),
			{ sessionId: 'session-1', workspaceId: 'workspace-1' }
		);
		recorder.record({
			type: 'turn_started',
			conversationId: 'conversation-active',
			requestId: 'r1',
			data: { userText: '当前会话问题' },
		});
		recorder.record({
			type: 'turn_started',
			conversationId: 'conversation-other',
			requestId: 'r2',
			data: { userText: '别的会话问题' },
		});
		recorder.record({
			type: 'turn_started',
			requestId: 'r3',
			data: { userText: '无会话归属事件' },
		});
		await recorder.flush();
		const bundle = await recorder.exportTo(path.join(directory, 'out.json'), {
			extensionVersion: '0.0.5',
			workspaceFolders: ['C:/ws'],
			activeConversationId: 'conversation-active',
			conversations: [
				{
					id: 'conversation-active',
					title: 'active',
					createdAt: 1,
					updatedAt: 1,
					inputDraft: '',
					messages: [],
				},
				{
					id: 'conversation-other',
					title: 'other',
					createdAt: 1,
					updatedAt: 1,
					inputDraft: '',
					messages: [],
				},
			],
		});
		assert.deepStrictEqual(
			bundle.conversations.map((conversation) => conversation.id),
			['conversation-active']
		);
		assert.strictEqual(bundle.events.length, 1);
		assert.strictEqual(bundle.events[0].conversationId, 'conversation-active');
		const serialized = await fs.readFile(path.join(directory, 'out.json'), 'utf8');
		assert.ok(!serialized.includes('conversation-other'));
		assert.ok(!serialized.includes('无会话归属事件'));
	});
});
