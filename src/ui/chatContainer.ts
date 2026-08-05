/**
 * Chat 容器状态:当前聊天显示在哪里。
 * - 'view': 聊天显示在 sidebar 的 ChatView 中;
 * - 'panel': 聊天显示在 editor 的 ChatPanel 中,sidebar 的 ChatView 必须隐藏;
 * - 'hidden': 聊天被用户主动隐藏,不显示在任何容器。
 *
 * 可见性本身交给 VS Code:package.json 里 ChatView 视图的 when 子句
 * (classmate.chatContainer == 'view')负责隐藏/显示,这里只提供纯函数。
 */
export type ChatContainer = 'view' | 'panel' | 'hidden';

/** 驱动 package.json 中 ChatView 视图 when 子句的 context key。 */
export const CHAT_CONTAINER_CONTEXT_KEY = 'classmate.chatContainer';

/** toggleChatContainer 的状态转移:view→panel、panel→view、hidden→panel。 */
export function nextChatContainer(current: ChatContainer): ChatContainer {
	if (current === 'hidden') {
		return 'panel';
	}
	return current === 'view' ? 'panel' : 'view';
}

/** openChat 打开聊天时的兜底:把 'hidden' 归一化为 'view'。 */
export function toVisibleContainer(container: ChatContainer): 'view' | 'panel' {
	return container === 'panel' ? 'panel' : 'view';
}
