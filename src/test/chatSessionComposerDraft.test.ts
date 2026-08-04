import * as assert from 'assert';
import { afterEach, beforeEach, describe, it } from 'mocha';
import { ChatSession } from '../chat/ChatSession';
import type { ExtensionToWebviewMessage, WebviewPresenter } from '../chat/types';

// 单元测试 ChatSession 的"输入草稿跨对话保留"以及"流期间 stateSync 瘦身"。
// 不依赖真实 LLM,只走 ChatSession 自身的状态机 + presenter。

class FakePresenter implements WebviewPresenter {
	public readonly received: ExtensionToWebviewMessage[] = [];

	postMessage(message: unknown): void {
		this.received.push(message as ExtensionToWebviewMessage);
	}

	dispose(): void {
		// no-op
	}
}

function lastStateSync(presenter: FakePresenter): { inputDraft?: string; messagesLength: number; isStreaming: boolean } | null {
	for (let i = presenter.received.length - 1; i >= 0; i--) {
		const m = presenter.received[i];
		if (m.type === 'stateSync') {
			const state = (m as { state: { inputDraft?: string; messages: unknown[]; isStreaming: boolean } }).state;
			return {
				inputDraft: state.inputDraft,
				messagesLength: state.messages.length,
				isStreaming: state.isStreaming,
			};
		}
	}
	return null;
}

describe('ChatSession composer draft race protection', () => {
	let presenter: FakePresenter;

	beforeEach(() => {
		ChatSession.resetInstance();
		presenter = new FakePresenter();
		ChatSession.getInstance().attach(presenter);
		// 清掉 attach 时的初始 stateSync,只看后续行为。
		presenter.received.length = 0;
	});

	afterEach(() => {
		ChatSession.resetInstance();
	});

	it('setInputDraft does NOT broadcast back (no echo = fast typing)', () => {
		const session = ChatSession.getInstance();

		// 用户按键 → inputDraftChanged。
		session.handleWebviewMessage({ type: 'inputDraftChanged', text: 'h' });
		session.handleWebviewMessage({ type: 'inputDraftChanged', text: 'he' });
		session.handleWebviewMessage({ type: 'inputDraftChanged', text: 'hello' });

		// 关键:这一系列 inputDraftChanged 不应触发任何 stateSync 广播。
		// 如果有,前端会在 IPC 来回里把 React 重渲染串行化,体感上字符跟不上打字。
		assert.strictEqual(presenter.received.length, 0,
			'setInputDraft 路径不能 echo stateSync(否则前端打字会卡顿)');

		// 但内部 _state.inputDraft 必须被更新,这样切走/落盘时拿到正确值。
		assert.strictEqual(session.getState().inputDraft, 'hello');
	});

	it('streaming stateSync does NOT carry inputDraft (so frontend local input is preserved)', () => {
		const session = ChatSession.getInstance();

		// 模拟一次发送:startAssistantMessage 会让 isStreaming=true,并附带 streamStart + stateSync。
		const assistant = session.startAssistantMessage();
		presenter.received.length = 0;

		// 流期间用户持续打字 —— setInputDraft 不再 echo,所以不应有 stateSync。
		session.handleWebviewMessage({ type: 'inputDraftChanged', text: '正在打字…' });
		assert.strictEqual(presenter.received.length, 0,
			'流期间 setInputDraft 不应 echo stateSync');

		// appendToken 不会直接发 stateSync。
		session.appendToken(assistant.id, 'Hello');

		// endStream:它会发一个 includeDraft=false 的 stateSync(流相关 stateSync 不带 inputDraft)。
		session.endStream();
		const afterEnd = lastStateSync(presenter);
		assert.strictEqual(typeof afterEnd?.inputDraft, 'undefined',
			'endStream 的 stateSync 应剥离 inputDraft(流期间不重写前端草稿)');
		assert.strictEqual(afterEnd?.isStreaming, false);
	});

	it('newConversation / switchConversation / clear all carry inputDraft explicitly', () => {
		const session = ChatSession.getInstance();

		session.handleWebviewMessage({ type: 'inputDraftChanged', text: 'first' });
		presenter.received.length = 0;

		session.newConversation();
		const a = lastStateSync(presenter);
		assert.strictEqual(a?.inputDraft, '', 'newConversation 应带 inputDraft=""');

		session.handleWebviewMessage({ type: 'inputDraftChanged', text: 'second' });
		presenter.received.length = 0;

		session.clear();
		const b = lastStateSync(presenter);
		assert.strictEqual(b?.inputDraft, '', 'clear 应带 inputDraft=""');
	});
});
