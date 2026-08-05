import * as assert from 'assert';
import { describe, it } from 'mocha';
import { nextChatContainer, toVisibleContainer } from '../ui/chatContainer';

describe('chatContainer state transitions', () => {
	it('toggles view to panel and back', () => {
		assert.strictEqual(nextChatContainer('view'), 'panel');
		assert.strictEqual(nextChatContainer('panel'), 'view');
	});

	it('toggles from hidden into panel', () => {
		assert.strictEqual(nextChatContainer('hidden'), 'panel');
	});

	it('maps hidden back to a visible container for openChat', () => {
		assert.strictEqual(toVisibleContainer('hidden'), 'view');
		assert.strictEqual(toVisibleContainer('view'), 'view');
		assert.strictEqual(toVisibleContainer('panel'), 'panel');
	});
});
