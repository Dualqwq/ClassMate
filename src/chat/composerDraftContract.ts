/**
 * 后端 → 前端 inputDraft 契约。
 *
 * ChatSession._broadcast 默认把 inputDraft 从 stateSync 中剥离:
 * 普通状态同步(流式阶段、usage、引用提取、会话列表等)不携带草稿,
 * 只有草稿语义真正变化的路径(attach / addUserMessage / newConversation /
 * switchConversation / deleteConversation(active) / clear)才显式携带。
 *
 * 因此"state 对象上是否存在 inputDraft 自有属性"就是"本次广播是否携带
 * 权威草稿"的判定。前端绝不能在字段缺失时把它当成"草稿为空"去清空输入框,
 * 否则任何后台状态同步都会把用户正在打的内容抹掉。
 */
export function hasAuthoritativeInputDraft(state: Record<string, unknown>): boolean {
	return Object.prototype.hasOwnProperty.call(state, 'inputDraft');
}
