import type { ClassMateTheme } from './types';

/** 只依赖 style.setProperty 的最小目标接口,便于在无 DOM 的测试环境注入替身。 */
export interface CssVariableTarget {
	style: { setProperty(name: string, value: string): void };
}

/** 主题字段 → CSS 自定义属性的唯一映射;webview 消费点由单测做闭环扫描。 */
export const THEME_VARIABLES: ReadonlyArray<readonly [keyof ClassMateTheme, string]> = [
	['userBubbleBackground', '--classmate-user-bubble-bg'],
	['userBubbleForeground', '--classmate-user-bubble-fg'],
	['assistantBubbleBackground', '--classmate-assistant-bubble-bg'],
	['assistantBubbleForeground', '--classmate-assistant-bubble-fg'],
	['linkColor', '--classmate-link-color'],
	['refFuncColor', '--classmate-ref-func'],
	['refTypeColor', '--classmate-ref-type'],
	['refVarColor', '--classmate-ref-var'],
	['refMacroColor', '--classmate-ref-macro'],
	['refStdColor', '--classmate-ref-std'],
	['refOtherColor', '--classmate-ref-other'],
];

/**
 * 把主题就地写入文档根节点的 CSS 自定义属性:自定义属性变化由浏览器原生
 * 传播到所有 var() 引用处,不需要 React 重渲染、不重建任何控件。
 * 空字段写成空串(等效移除属性),var() 随即回退到 VS Code 默认变量。
 * root 缺省时取当前文档根节点;环境没有 DOM(单测/node)时静默跳过。
 */
export function applyClassMateTheme(theme: ClassMateTheme, root?: CssVariableTarget): void {
	const target = root ?? (globalThis as { document?: CssVariableTarget }).document;
	if (!target) {
		return;
	}
	for (const [key, variable] of THEME_VARIABLES) {
		target.style.setProperty(variable, theme[key] || '');
	}
}
