import * as assert from 'assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it } from 'mocha';
import { ChatSession } from '../chat/ChatSession';
import {
	ConversationDiagnosticRecorder,
	parseConversationDiagnosticBundle,
} from '../chat/conversationDiagnostics';

describe('ChatSession conversation diagnostics export', () => {
	it('exports only the active conversation together with its graph events', async () => {
		ChatSession.resetInstance();
		const session = ChatSession.getInstance();
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'classmate-chat-export-'));
		const outputPath = path.join(directory, 'diagnostics.json');
		const recorder = new ConversationDiagnosticRecorder(
			path.join(directory, 'journal.jsonl'),
			{ sessionId: 'session-chat', workspaceId: 'workspace-chat' }
		);
		session.configurePersistence(undefined, async () => undefined);
		session.setDiagnosticRecorder(recorder, {
			extensionVersion: '0.0.5',
			workspaceFolders: ['C:/workspace'],
		});
		session.setLLMConfig({
			provider: 'deepseek',
			model: 'deepseek-v4-flash',
			apiKeySet: true,
		});

		const firstConversationId = session.getState().activeConversationId;
		session.addUserMessage('第一段对话');
		const firstAnswer = session.startAssistantMessage();
		session.appendToken(firstAnswer.id, '第一段回答');
		session.endStream();
		session.newConversation();
		const secondConversationId = session.getState().activeConversationId;
		session.addUserMessage('第二段对话');
		const secondAnswer = session.startAssistantMessage();
		session.appendToken(secondAnswer.id, '第二段回答');
		session.endStream();
		recorder.record({
			type: 'graph_node_completed',
			conversationId: secondConversationId,
			requestId: 'request-second',
			data: { node: 'answer', state: { answer: '第二段回答' } },
		});

		await session.exportDiagnostics(outputPath, { reveal: false });
		const bundle = parseConversationDiagnosticBundle(JSON.parse(
			await fs.readFile(outputPath, 'utf8')
		));

		// 新语义:只导出 active 会话(第二段),非 active 会话(第一段)不出。
		assert.strictEqual(bundle.conversations.length, 1);
		assert.strictEqual(bundle.conversations[0].id, secondConversationId);
		assert.deepStrictEqual(
			bundle.conversations[0].messages.map((message) => message.content),
			['第二段对话', '第二段回答']
		);
		assert.strictEqual(bundle.events.length, 1);
		assert.strictEqual(bundle.events[0].requestId, 'request-second');
		const serialized = await fs.readFile(outputPath, 'utf8');
		assert.ok(!serialized.includes('第一段对话'), '非 active 会话内容不得进入导出');
		assert.ok(!serialized.includes(firstConversationId));
		assert.strictEqual(bundle.provider, 'deepseek');
		assert.strictEqual(bundle.model, 'deepseek-v4-flash');
	});
});
