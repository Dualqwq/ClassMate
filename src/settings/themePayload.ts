import type { ClassMateTheme } from '../chat/types';

/**
 * 主题字段单一事实源:key = ClassMateTheme 字段名,id = 设置页 color input 的
 * DOM id。设置页脚本(经 JSON 注入)与载荷构造共用这一份清单,杜绝两份
 * 手抄表漂移。
 */
export const THEME_FIELDS: ReadonlyArray<readonly [keyof ClassMateTheme, string]> = [
	['userBubbleBackground', 'userBubbleBg'],
	['userBubbleForeground', 'userBubbleFg'],
	['assistantBubbleBackground', 'assistantBubbleBg'],
	['assistantBubbleForeground', 'assistantBubbleFg'],
	['linkColor', 'linkColor'],
	['refFuncColor', 'refFunc'],
	['refTypeColor', 'refType'],
	['refVarColor', 'refVar'],
	['refMacroColor', 'refMacro'],
	['refStdColor', 'refStd'],
	['refOtherColor', 'refOther'],
];

export interface ThemeFieldInput {
	key: string;
	value: string;
	/** 用户是否手动改过该字段(input 监听置位;初始回填/重置为 false)。 */
	custom: boolean;
}

/**
 * 由设置页控件状态构造 POST /api/theme 载荷。
 *
 * G5 复测取证:此逻辑原先内嵌在设置页 <script> HTML 字符串里,任何测试都
 * 无法执行它,"载荷恒为空串导致保存完全无效"的回归因此漏网(b09ff13 只补了
 * 包含性断言,仍非行为级证据)。现为纯函数:浏览器端经 toString() 注入页面
 * 直接调用,单测直接调用同一份实现——两端行为不可能分叉。
 * 仅 custom 且值非空的字段进入载荷;其余字段缺席(服务端视为"未设置",
 * 持久化与广播随之不含该键)。
 */
export function buildThemePayload(fields: ThemeFieldInput[]): Partial<ClassMateTheme> {
	const theme: Record<string, string> = {};
	for (const field of fields) {
		if (field.custom && typeof field.value === 'string' && field.value.trim()) {
			theme[field.key] = field.value.trim();
		}
	}
	return theme as Partial<ClassMateTheme>;
}
