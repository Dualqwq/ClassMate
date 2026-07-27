/**
 * 判断用户是否明确要求 ClassMate 直接修改代码。
 *
 * “请修改这个函数”属于编辑请求；
 * “告诉我修改方向”“为什么会出错、怎么修复”只是答疑，不能擅自当成编辑请求。
 */
export function looksLikeCodeEditRequest(text: string): boolean {
	const chineseExplicitRequest =
		/(?:帮我|请你?|直接)\s*(?:修改|改成|改一下|重构|修复|替换)/;
	const chineseImperativeAtStart =
		/^\s*(?:修改|改一下|重构|修复|替换)(?:这个|该|当前|一下|代码|文件|函数)/;
	const englishExplicitRequest =
		/^\s*(?:(?:please|can you|could you)\s+)?(?:edit|modify|refactor|change|fix)\s+(?:this|the|my|current|code|file|function)\b/i;
	return chineseExplicitRequest.test(text)
		|| chineseImperativeAtStart.test(text)
		|| englishExplicitRequest.test(text);
}
