import * as assert from 'assert';
import { describe, it } from 'mocha';
import { hasAuthoritativeInputDraft } from '../chat/composerDraftContract';

describe('composer draft broadcast contract', () => {
	it('treats a stateSync that carries inputDraft as authoritative', () => {
		assert.strictEqual(
			hasAuthoritativeInputDraft({
				messages: [],
				inputDraft: '帮我看看',
				isStreaming: true,
				currentStreamMessageId: null,
				processingStage: null,
				activeConversationId: 'c1',
				conversations: [],
			}),
			true
		);
	});

	it('treats a stripped stateSync (no inputDraft property) as non-authoritative', () => {
		// ChatSession._broadcast 默认用解构剥离 inputDraft,字段完全不存在。
		assert.strictEqual(
			hasAuthoritativeInputDraft({
				messages: [],
				isStreaming: false,
				currentStreamMessageId: null,
				processingStage: null,
				activeConversationId: 'c1',
				conversations: [],
			}),
			false
		);
	});

	it('does not mistake a missing field for an empty draft', () => {
		// 字段存在但值为空串才是"权威清空";字段缺失只是"本次没带草稿"。
		assert.strictEqual(
			hasAuthoritativeInputDraft({ inputDraft: '' }),
			true
		);
		assert.strictEqual(
			hasAuthoritativeInputDraft({}),
			false
		);
	});
});
