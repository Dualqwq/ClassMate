import * as assert from 'assert';
import { afterEach, beforeEach, describe, it } from 'mocha';
import { ChatSession } from '../chat/ChatSession';
import type { ExtensionToWebviewMessage, WebviewPresenter } from '../chat/types';

// 单元测试 ChatSession.deleteConversation 的会话记录删除语义:
// 删非当前会话、删当前会话的回退、流式中忽略、未知 id 无副作用。

class FakePresenter implements WebviewPresenter {
	public readonly received: ExtensionToWebviewMessage[] = [];

	postMessage(message: unknown): void {
		this.received.push(message as ExtensionToWebviewMessage);
	}

	dispose(): void {
		// no-op
	}
}

function lastStateSync(
	presenter: FakePresenter
): { activeConversationId: string; conversationsLength: number; inputDraft?: string } | null {
	for (let i = presenter.received.length - 1; i >= 0; i--) {
		const m = presenter.received[i];
		if (m.type === 'stateSync') {
			const state = (m as {
				state: { activeConversationId: string; conversations: unknown[]; inputDraft?: string };
			}).state;
			return {
				activeConversationId: state.activeConversationId,
				conversationsLength: state.conversations.length,
				inputDraft: state.inputDraft,
			};
		}
	}
	return null;
}

describe('ChatSession deleteConversation', () => {
	let presenter: FakePresenter;
	let session: ChatSession;

	beforeEach(() => {
		ChatSession.resetInstance();
		presenter = new FakePresenter();
		session = ChatSession.getInstance();
		session.attach(presenter);
		presenter.received.length = 0;
	});

	afterEach(() => {
		ChatSession.resetInstance();
	});

	/** 在当前会话发一条消息后新建会话,返回刚保存的会话 id。 */
	function seedConversation(prompt: string, draft = ''): string {
		session.handleWebviewMessage({ type: 'inputDraftChanged', text: draft });
		session.addUserMessage(prompt);
		const id = session.getState().activeConversationId;
		session.newConversation();
		presenter.received.length = 0;
		return id;
	}

	it('deletes a non-active conversation and keeps the active one', () => {
		const a = seedConversation('hello');
		const b = seedConversation('world');
		session.switchConversation(a);
		presenter.received.length = 0;

		session.deleteConversation(b);

		const sync = lastStateSync(presenter);
		assert.strictEqual(sync?.activeConversationId, a);
		assert.ok(
			session.getState().conversations.every((c) => c.id !== b),
			'被删除的会话不应再出现在摘要里'
		);
	});

	it('deleting the active conversation falls back to a remaining conversation', () => {
		const a = seedConversation('hello');
		seedConversation('world');
		session.switchConversation(a);
		presenter.received.length = 0;

		session.deleteConversation(a);

		const sync = lastStateSync(presenter);
		assert.notStrictEqual(sync?.activeConversationId, a, 'active 应切到剩余会话');
		assert.ok(
			session.getState().conversations.every((c) => c.id !== a),
			'被删除的会话不应再出现在摘要里'
		);
	});

	it('deleting the last conversation creates a fresh empty conversation', () => {
		const a = seedConversation('hello');
		session.switchConversation(a);
		presenter.received.length = 0;

		session.deleteConversation(a);

		const sync = lastStateSync(presenter);
		assert.notStrictEqual(sync?.activeConversationId, a);
		assert.strictEqual(sync?.conversationsLength, 1, '应只剩一个新建的空会话');
		assert.strictEqual(session.getState().messages.length, 0, '空会话不应带历史消息');
	});

	it('ignores delete while streaming', () => {
		const a = seedConversation('hello');
		session.startAssistantMessage();
		presenter.received.length = 0;

		session.deleteConversation(a);

		assert.strictEqual(presenter.received.length, 0, '流式中删除不应广播');
		assert.ok(session.getState().conversations.some((c) => c.id === a));
	});

	it('is a no-op for an unknown conversation id', () => {
		seedConversation('hello');
		presenter.received.length = 0;

		session.deleteConversation('conversation-does-not-exist');

		assert.strictEqual(presenter.received.length, 0, '未知 id 不应触发任何广播');
	});
});
