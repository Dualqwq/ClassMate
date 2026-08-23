import * as assert from 'assert';
import { afterEach, beforeEach, describe, it } from 'mocha';
import { ChatSession } from '../chat/ChatSession';
import type { ExtensionToWebviewMessage, WebviewPresenter } from '../chat/types';

// 单元测试 ChatSession 的主题缓存与 attach 补推(G5 第五轮):
// 面板错过广播/重挂后,必须立即拿到当前主题,不依赖 requestTheme 异步往返。

class FakePresenter implements WebviewPresenter {
	public readonly received: ExtensionToWebviewMessage[] = [];

	postMessage(message: unknown): void {
		this.received.push(message as ExtensionToWebviewMessage);
	}

	dispose(): void {
		// no-op
	}
}

describe('ChatSession theme cache and attach replay', () => {
	beforeEach(() => {
		ChatSession.resetInstance();
	});

	afterEach(() => {
		ChatSession.resetInstance();
	});

	it('replays the latest broadcast theme to a newly attached presenter', () => {
		const session = ChatSession.getInstance();
		const theme = { userBubbleBackground: '#ff8800', userBubbleForeground: '#ff0000' };
		session.broadcastThemeUpdate(theme);

		const latePanel = new FakePresenter();
		session.attach(latePanel);

		const themeUpdate = latePanel.received.find((message) => message.type === 'themeUpdate');
		assert.ok(themeUpdate, 'newly attached panel did not receive a themeUpdate');
		assert.deepStrictEqual(
			(themeUpdate as { theme: unknown }).theme,
			theme,
			'replayed theme differs from the last broadcast'
		);
	});

	it('does not fabricate a themeUpdate before any theme was broadcast', () => {
		const session = ChatSession.getInstance();
		const presenter = new FakePresenter();
		session.attach(presenter);

		assert.strictEqual(
			presenter.received.some((message) => message.type === 'themeUpdate'),
			false,
			'attach must not invent a theme when none was ever set'
		);
	});

	it('later broadcasts win: the cache always holds the newest theme', () => {
		const session = ChatSession.getInstance();
		session.broadcastThemeUpdate({ linkColor: '#111111' });
		session.broadcastThemeUpdate({ linkColor: '#222222' });

		const latePanel = new FakePresenter();
		session.attach(latePanel);
		const themeUpdate = latePanel.received.find((message) => message.type === 'themeUpdate');
		assert.deepStrictEqual((themeUpdate as { theme: unknown }).theme, { linkColor: '#222222' });
	});

	it('broadcasts to every attached presenter (view and panel surfaces alike)', () => {
		// G5 第七轮表面覆盖:广播必须同时命中所有存活 chat 表面,
		// 不能只投给先注册的那个(否则另一表面的用户永不变色)。
		const session = ChatSession.getInstance();
		const sidebar = new FakePresenter();
		const editorPanel = new FakePresenter();
		session.attach(sidebar);
		session.attach(editorPanel);

		session.broadcastThemeUpdate({ userBubbleBackground: '#ff8800' });

		assert.ok(
			sidebar.received.some((message) => message.type === 'themeUpdate'),
			'sidebar surface missed the broadcast'
		);
		assert.ok(
			editorPanel.received.some((message) => message.type === 'themeUpdate'),
			'editor panel surface missed the broadcast'
		);
	});
});
