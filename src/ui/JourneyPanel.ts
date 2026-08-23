import * as vscode from 'vscode';
import { getJourneyWebviewHtml } from './getJourneyWebviewHtml';
import { registerClassMatePanel, resolveNewPanelColumn, resolveRelocationTarget } from './panelGrouping';
import { COMPILE_OUTPUT_SCHEME } from '../compiler/outputPanel';
import type { JourneyWebviewToExtensionMessage } from '../chat/types';
import type { JourneyService } from '../journey/journeyService';

/**
 * 大屏唯一权威入口(docs/journey-panel-state-machine.md §3/§4 不变量 2、4):
 * 命令面板与一切小屏入口(编辑器工具栏/Journey 树标题栏/ChatView 标题栏/
 * 树项动作)都只允许经本函数打开大屏;内部收敛到单例 createOrShow——
 * 已打开时 reveal 聚焦不重建,未创建时按 B1 分组决策落列并登记注册表。
 * 禁止绕过本函数(或 createOrShow)直接创建 Journey 面板。
 */
export function openJourneyPanel(
	extensionUri: vscode.Uri,
	journeyService: JourneyService,
	options?: { preserveFocus?: boolean }
): void {
	JourneyPanel.createOrShow(extensionUri, journeyService, options);
}


/**
 * Journey 面板(#12a):与 Chat Panel / Run Panel 同级的大标签页 WebviewPanel,
 * 常驻(retainContextWhenHidden),关闭后重开状态仍在(数据每次 attach 重取)。
 *
 * 分组/闪屏策略完全复用 B1 的 panelGrouping 机制(与 RunPanel 同一模板):
 * - 创建时按 resolveNewPanelColumn 落列(不盖住正在看的源码);
 * - 创建即登记 registerClassMatePanel,dispose 注销——此后
 *   showTextDocumentRespectingPanels 的 ADD2 预路由对本面板生效;
 * - 外部打开落进面板组时,与 Chat/Run 相同的 relocation 兜底挪去对侧列。
 */
export class JourneyPanel {
	public static readonly viewType = 'classmate.journeyPanel';
	private static _currentPanel: JourneyPanel | undefined;

	private readonly _panel: vscode.WebviewPanel;
	private readonly _journeyService: JourneyService;
	private _disposables: vscode.Disposable[] = [];
	/** 面板是否为 active 标签(打开新文件前),由 viewState 与 tab 事件共同维护。 */
	private _panelWasActive = false;
	private _relocating = false;
	private _inactiveTimeout: ReturnType<typeof setTimeout> | undefined;
	private _isDisposed = false;

	public static createOrShow(
		extensionUri: vscode.Uri,
		journeyService: JourneyService,
		options?: { preserveFocus?: boolean }
	): JourneyPanel {
		const activeEditor = vscode.window.activeTextEditor;
		const visibleEditors = vscode.window.visibleTextEditors;
		const activeColumn = activeEditor?.viewColumn;

		if (JourneyPanel._currentPanel) {
			JourneyPanel._currentPanel._panel.reveal(activeColumn, options?.preserveFocus ?? false);
			return JourneyPanel._currentPanel;
		}

		const targetColumn = resolveNewPanelColumn(visibleEditors.length, activeColumn, {
			// active 是 compile_result.txt(classmate-output: 虚拟文档)时,
			// 面板与它同分组打开(同为 ClassMate 面板面,不当源码避让)。
			activeEditorIsClassMateOutput:
				activeEditor?.document.uri.scheme === COMPILE_OUTPUT_SCHEME,
		});

		const panel = vscode.window.createWebviewPanel(
			JourneyPanel.viewType,
			'ClassMate 调试历程',
			{ viewColumn: targetColumn, preserveFocus: options?.preserveFocus ?? false },
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist')],
			}
		);

		JourneyPanel._currentPanel = new JourneyPanel(panel, extensionUri, journeyService);
		return JourneyPanel._currentPanel;
	}

	public static hasCurrent(): boolean {
		return JourneyPanel._currentPanel !== undefined;
	}

	public static revealCurrent(preserveFocus?: boolean): void {
		JourneyPanel._currentPanel?._panel.reveal(undefined, preserveFocus ?? false);
	}

	private constructor(
		panel: vscode.WebviewPanel,
		extensionUri: vscode.Uri,
		journeyService: JourneyService
	) {
		this._panel = panel;
		this._journeyService = journeyService;
		this._panelWasActive = panel.active;

		this._panel.webview.html = getJourneyWebviewHtml(this._panel.webview, extensionUri);

		this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
		this._panel.onDidChangeViewState(
			(event) => this._updatePanelActive(event.webviewPanel.active),
			null,
			this._disposables
		);
		this._disposables.push(
			vscode.window.tabGroups.onDidChangeTabs((event) => this._handleTabChange(event))
		);
		// 登记到 ClassMate 面板注册表:ADD2 分组决策以「任一已登记面板的
		// active 列」为准,Journey 面板与 Chat/Run 平权参与。
		this._disposables.push(
			registerClassMatePanel({
				viewType: JourneyPanel.viewType,
				getActiveColumn: () => (this._panel.active ? this._panel.viewColumn : undefined),
			})
		);
		this._panel.webview.onDidReceiveMessage(
			(message: unknown) =>
				void this._journeyService.handleMessage(message as JourneyWebviewToExtensionMessage),
			null,
			this._disposables
		);
		void this._journeyService.attach(this);
	}

	public postMessage(message: unknown): void {
		void this._panel.webview.postMessage(message);
	}

	public dispose(): void {
		if (this._isDisposed) {
			return;
		}
		this._isDisposed = true;
		// 失活冷却定时器可能在 dispose 后才到期,回调里访问 panel.active 会抛
		// "Webview is disposed" 并毒化整个扩展宿主(未捕获异常);先清再拆。
		if (this._inactiveTimeout) {
			clearTimeout(this._inactiveTimeout);
			this._inactiveTimeout = undefined;
		}
		JourneyPanel._currentPanel = undefined;
		this._journeyService.detach();
		this._panel.dispose();
		while (this._disposables.length) {
			const x = this._disposables.pop();
			if (x) {
				x.dispose();
			}
		}
	}

	/**
	 * 新文本文件开进面板所在组时的处理(与 Chat/Run 同一兜底):
	 * 仅在面板是打开前的 active 标签时,把新文件挪到对侧分屏。
	 */
	private _handleTabChange(event: vscode.TabChangeEvent): void {
		if (this._relocating) {
			return;
		}
		const panelColumn = this._panel.viewColumn;
		if (panelColumn === undefined || !this._panelWasActive) {
			return;
		}
		const openedTextTab = event.opened.find(
			(tab) => tab.input instanceof vscode.TabInputText && tab.group.viewColumn === panelColumn
		);
		if (!openedTextTab || !(openedTextTab.input instanceof vscode.TabInputText)) {
			return;
		}
		this._relocating = true;
		void this._relocate(openedTextTab, panelColumn).finally(() => {
			this._relocating = false;
		});
	}

	private async _relocate(
		openedTextTab: vscode.Tab,
		panelColumn: vscode.ViewColumn
	): Promise<void> {
		const uri = openedTextTab.input instanceof vscode.TabInputText
			? openedTextTab.input.uri
			: undefined;
		if (!uri) {
			return;
		}
		const wasPreview = openedTextTab.isPreview;
		const target = resolveRelocationTarget(panelColumn);
		try {
			// 并行 close+open,与 Chat/Run 同一策略,窗口最短。
			const results = await Promise.allSettled([
				vscode.window.tabGroups.close(openedTextTab, true),
				vscode.window.showTextDocument(uri, {
					viewColumn: target,
					preview: wasPreview,
				}),
			]);
			for (const result of results) {
				if (result.status === 'rejected') {
					console.warn(
						'[ClassMate] failed to relocate opened file away from journey panel',
						result.reason
					);
				}
			}
		} catch (error) {
			console.warn('[ClassMate] failed to relocate opened file away from journey panel', error);
		}
	}

	/** 与 Chat/Run 相同的失活 250ms 冷却期维护。 */
	private _updatePanelActive(active: boolean): void {
		if (active) {
			if (this._inactiveTimeout) {
				clearTimeout(this._inactiveTimeout);
				this._inactiveTimeout = undefined;
			}
			this._panelWasActive = true;
			return;
		}
		if (!this._inactiveTimeout) {
			this._inactiveTimeout = setTimeout(() => {
				this._inactiveTimeout = undefined;
				// dispose 竞态兜底:定时器到期时面板可能已销毁(双保险,
				// dispose 里也会清),此时不得再触碰 panel.active。
				if (this._isDisposed) {
					return;
				}
				this._panelWasActive = this._panel.active;
			}, 250);
		}
	}
}
