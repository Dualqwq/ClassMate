import * as vscode from 'vscode';

/**
 * ClassMate 面板分组决策(ADD2 泛化 + #18 前置,挂在 #16 容器状态机上)。
 *
 * #16 已在 chatContainer.ts 落地 ChatView/ChatPanel 的显隐状态机
 * (view/panel/hidden + context key 驱动 when 子句)。本模块不另起状态机,
 * 只提供"任意 ClassMate 大屏面板(WebviewPanel)与源码编辑器如何分组"的
 * 共用决策,供 Chat Panel 与后续 Run Panel 复用:
 *
 * - {@link resolveNewPanelColumn}:新建面板放哪一列(不盖住正在看的源码)。
 * - {@link resolveFileOpenTarget}:打开文件去哪一组(ADD2 统一逻辑)——
 *   active 标签不是 ClassMate 面板 → 跟随 active 组;是 ClassMate 面板 →
 *   开到面板之外、已有文件的分组,没有则创建对侧分组。
 * - {@link resolveRelocationTarget}:文件仍落进面板组时(外部打开,如
 *   Explorer 点击)挪往的对侧列。
 *
 * #18(面板组闪屏)结论:VS Code Tab API 只有 onDidChangeTabs(事后)与
 * close(),没有 onWillOpenEditor 钩子、没有 tab move API(证据见
 * @types/vscode TabGroups 接口);非预路由的打开必然在面板组渲染至少一帧,
 * 无法彻底消除。最佳可行 = ClassMate 发起的打开一律经
 * {@link showTextDocumentRespectingPanels} 预路由(零闪屏),外部打开由
 * ChatPanel 的 relocation 兜底(并行 close+open,窗口最短)。
 */

/** 分组快照:分组决策只依赖这两个字段,便于纯函数单测。 */
export interface EditorGroupSnapshot {
	viewColumn: vscode.ViewColumn;
	/** 组内是否有文本文件 tab(相对 webview/设置页等非文本 tab)。 */
	hasTextTab: boolean;
}

/** 把 Tab API 的分组折算成决策快照。 */
export function snapshotTabGroups(groups: readonly vscode.TabGroup[]): EditorGroupSnapshot[] {
	return groups.map((group) => ({
		viewColumn: group.viewColumn,
		hasTextTab: group.tabs.some((tab) => tab.input instanceof vscode.TabInputText),
	}));
}

/**
 * Resolve which ViewColumn a newly-created ClassMate panel should occupy.
 * 纯函数,不依赖 live UI 状态,可直接单测。
 *
 * activeEditorIsClassMateOutput:active 编辑器是 ClassMate 产出的虚拟文档
 * (compile_result.txt,classmate-output: scheme)时置真——它与面板同为
 * ClassMate 面板面,面板开进它所在组(同分组),而不是按源码编辑器对待
 * 劈到别的列。虚拟文档在 Tab API 里就是普通 TabInputText,分组决策一律
 * 视为普通文件编辑器参与。
 */
export function resolveNewPanelColumn(
	visibleEditorCount: number,
	activeColumn: vscode.ViewColumn | undefined,
	options?: { activeEditorIsClassMateOutput?: boolean }
): vscode.ViewColumn {
	if (options?.activeEditorIsClassMateOutput && activeColumn !== undefined) {
		return activeColumn;
	}
	const hasSplitView = visibleEditorCount > 1;
	if (
		hasSplitView &&
		activeColumn !== undefined &&
		activeColumn !== vscode.ViewColumn.One
	) {
		return vscode.ViewColumn.One;
	}
	return vscode.ViewColumn.Two;
}

/** 文件打开目标:viewColumn 为 undefined 表示跟随 active 组(原语义)。 */
export interface FileOpenTarget {
	viewColumn: vscode.ViewColumn | undefined;
}

/**
 * ADD2 统一分组逻辑(泛化到任意 ClassMate 面板):
 * 没有 ClassMate 面板是 active 标签 → 在 active 组打开;
 * 有 → 在面板之外、已有文本文件的分组打开;没有这样的分组 → 在面板对侧创建。
 */
export function resolveFileOpenTarget(
	activePanelColumn: vscode.ViewColumn | undefined,
	groups: readonly EditorGroupSnapshot[]
): FileOpenTarget {
	if (activePanelColumn === undefined) {
		return { viewColumn: undefined };
	}
	const fileGroup = groups.find(
		(group) => group.viewColumn !== activePanelColumn && group.hasTextTab
	);
	return {
		viewColumn: fileGroup?.viewColumn
			?? (activePanelColumn === vscode.ViewColumn.One
				? vscode.ViewColumn.Two
				: vscode.ViewColumn.One),
	};
}

/**
 * 面板被新文件挤占时,把新文件挪到的对侧分屏列。
 * 面板在 One → 目标 Two;其余情况 → One。
 */
export function resolveRelocationTarget(panelColumn: vscode.ViewColumn): vscode.ViewColumn {
	return panelColumn === vscode.ViewColumn.One ? vscode.ViewColumn.Two : vscode.ViewColumn.One;
}

/**
 * ClassMate 大屏面板注册表。任何 ClassMate WebviewPanel(Chat/Run/…)
 * 在创建时登记、dispose 时注销;分组决策以"任一已登记面板的 active 列"
 * 为准,不绑死某个具体面板类。WebviewPanel.active 全局至多一个为真
 * (focused by the user),登记顺序不影响结果。
 */
export interface ClassMatePanelRegistration {
	readonly viewType: string;
	/** 面板为 active 标签时返回所在列,否则 undefined。 */
	getActiveColumn(): vscode.ViewColumn | undefined;
}

const panelRegistrations = new Set<ClassMatePanelRegistration>();

export function registerClassMatePanel(registration: ClassMatePanelRegistration): vscode.Disposable {
	panelRegistrations.add(registration);
	return new vscode.Disposable(() => {
		panelRegistrations.delete(registration);
	});
}

/** 当前 active 的 ClassMate 面板所在列;没有面板 active 时 undefined。 */
export function getActiveClassMatePanelColumn(): vscode.ViewColumn | undefined {
	for (const registration of panelRegistrations) {
		const column = registration.getActiveColumn();
		if (column !== undefined) {
			return column;
		}
	}
	return undefined;
}

/**
 * 按 ADD2 统一逻辑打开文本文件:先算好目标列再 showTextDocument,
 * 文件一步到位落进正确分组,不经过面板组(#18 零闪屏路径)。
 * active 标签不是 ClassMate 面板时行为与裸 showTextDocument 完全一致。
 */
export async function showTextDocumentRespectingPanels(
	document: vscode.TextDocument,
	options: { preview?: boolean; selection?: vscode.Range; preserveFocus?: boolean } = {}
): Promise<vscode.TextEditor> {
	const target = resolveFileOpenTarget(
		getActiveClassMatePanelColumn(),
		snapshotTabGroups(vscode.window.tabGroups.all)
	);
	return vscode.window.showTextDocument(document, {
		preview: options.preview,
		selection: options.selection,
		preserveFocus: options.preserveFocus,
		...(target.viewColumn !== undefined ? { viewColumn: target.viewColumn } : {}),
	});
}
