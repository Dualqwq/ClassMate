import * as assert from 'assert';
import { describe, it } from 'mocha';
import * as vscode from 'vscode';
import {
	getActiveClassMatePanelColumn,
	registerClassMatePanel,
	resolveFileOpenTarget,
	resolveNewPanelColumn,
	resolveRelocationTarget,
	snapshotTabGroups,
	type EditorGroupSnapshot,
} from '../ui/panelGrouping';

// 分组决策是纯函数,不依赖 live UI 状态;快照由测试手工构造。

function group(viewColumn: vscode.ViewColumn, hasTextTab: boolean): EditorGroupSnapshot {
	return { viewColumn, hasTextTab };
}

describe('resolveNewPanelColumn (面板新建落列)', () => {
	it('opens in column Two when there is no split view', () => {
		assert.strictEqual(resolveNewPanelColumn(1, undefined), vscode.ViewColumn.Two);
		assert.strictEqual(resolveNewPanelColumn(1, vscode.ViewColumn.One), vscode.ViewColumn.Two);
		assert.strictEqual(resolveNewPanelColumn(1, vscode.ViewColumn.Two), vscode.ViewColumn.Two);
	});

	it('avoids covering the active source editor when split', () => {
		// Active editor is in column Two -> panel should go to column One.
		assert.strictEqual(resolveNewPanelColumn(2, vscode.ViewColumn.Two), vscode.ViewColumn.One);
		assert.strictEqual(resolveNewPanelColumn(3, vscode.ViewColumn.Two), vscode.ViewColumn.One);
	});

	it('falls back to column Two when active editor is already in column One', () => {
		assert.strictEqual(resolveNewPanelColumn(2, vscode.ViewColumn.One), vscode.ViewColumn.Two);
		assert.strictEqual(resolveNewPanelColumn(3, vscode.ViewColumn.One), vscode.ViewColumn.Two);
	});

	it('falls back to column Two when active column is unknown', () => {
		assert.strictEqual(resolveNewPanelColumn(2, undefined), vscode.ViewColumn.Two);
	});

	it('compile_result.txt(classmate-output 虚拟文档)active 时,面板与其同分组', () => {
		const asOutput = { activeEditorIsClassMateOutput: true };
		// 无分屏:不再劈出 Two,而是开进虚拟文档所在的 One。
		assert.strictEqual(resolveNewPanelColumn(1, vscode.ViewColumn.One, asOutput), vscode.ViewColumn.One);
		// 有分屏且虚拟文档在 Two:面板进 Two(同组),而不是按源码避让去 One。
		assert.strictEqual(resolveNewPanelColumn(2, vscode.ViewColumn.Two, asOutput), vscode.ViewColumn.Two);
		assert.strictEqual(resolveNewPanelColumn(3, vscode.ViewColumn.Three, asOutput), vscode.ViewColumn.Three);
		// 标志为假时维持源码避让语义不变。
		assert.strictEqual(
			resolveNewPanelColumn(2, vscode.ViewColumn.Two, { activeEditorIsClassMateOutput: false }),
			vscode.ViewColumn.One
		);
		// 标志为真但 active 列未知(无 active 编辑器):走原兜底。
		assert.strictEqual(resolveNewPanelColumn(1, undefined, asOutput), vscode.ViewColumn.Two);
	});
});

describe('resolveFileOpenTarget (ADD2 统一分组)', () => {
	it('跟随 active 组:没有 ClassMate 面板 active 时不指定列', () => {
		assert.strictEqual(resolveFileOpenTarget(undefined, []).viewColumn, undefined);
		assert.strictEqual(
			resolveFileOpenTarget(undefined, [group(vscode.ViewColumn.One, true)]).viewColumn,
			undefined
		);
	});

	it('面板 active 且无其他分组时,在面板对侧创建分组', () => {
		const groups = [group(vscode.ViewColumn.One, false)];
		assert.strictEqual(
			resolveFileOpenTarget(vscode.ViewColumn.One, groups).viewColumn,
			vscode.ViewColumn.Two
		);
		assert.strictEqual(
			resolveFileOpenTarget(vscode.ViewColumn.Two, [group(vscode.ViewColumn.Two, false)]).viewColumn,
			vscode.ViewColumn.One
		);
		// 面板在三列布局的第三列:对侧兜底固定为 One(与 relocation 目标一致)。
		assert.strictEqual(
			resolveFileOpenTarget(vscode.ViewColumn.Three, [group(vscode.ViewColumn.Three, false)]).viewColumn,
			vscode.ViewColumn.One
		);
	});

	it('面板 active 且存在文件分组时,复用面板之外的文件分组', () => {
		const groups = [
			group(vscode.ViewColumn.One, true),
			group(vscode.ViewColumn.Two, false), // 面板组
		];
		assert.strictEqual(
			resolveFileOpenTarget(vscode.ViewColumn.Two, groups).viewColumn,
			vscode.ViewColumn.One
		);
	});

	it('跳过没有文本文件的分组(如只有 webview 的组)', () => {
		const groups = [
			group(vscode.ViewColumn.One, false), // 非文本组,不可用
			group(vscode.ViewColumn.Two, false), // 面板组
			group(vscode.ViewColumn.Three, true),
		];
		assert.strictEqual(
			resolveFileOpenTarget(vscode.ViewColumn.Two, groups).viewColumn,
			vscode.ViewColumn.Three
		);
	});
});

describe('resolveRelocationTarget (挤占挪移目标)', () => {
	it('moves new files to the opposite column of the panel', () => {
		assert.strictEqual(resolveRelocationTarget(vscode.ViewColumn.One), vscode.ViewColumn.Two);
		assert.strictEqual(resolveRelocationTarget(vscode.ViewColumn.Two), vscode.ViewColumn.One);
		assert.strictEqual(resolveRelocationTarget(vscode.ViewColumn.Three), vscode.ViewColumn.One);
	});
});

describe('ClassMate 面板注册表', () => {
	it('无登记或无 active 面板时返回 undefined', () => {
		assert.strictEqual(getActiveClassMatePanelColumn(), undefined);
		const idle = registerClassMatePanel({
			viewType: 'test.idle',
			getActiveColumn: () => undefined,
		});
		assert.strictEqual(getActiveClassMatePanelColumn(), undefined);
		idle.dispose();
	});

	it('返回任一已登记 active 面板所在列,dispose 后失效', () => {
		const active = registerClassMatePanel({
			viewType: 'test.active',
			getActiveColumn: () => vscode.ViewColumn.Two,
		});
		assert.strictEqual(getActiveClassMatePanelColumn(), vscode.ViewColumn.Two);
		active.dispose();
		assert.strictEqual(getActiveClassMatePanelColumn(), undefined);
	});

	it('多个登记时以 active 者为准(与 WebviewPanel.active 全局唯一一致)', () => {
		const idle = registerClassMatePanel({
			viewType: 'test.idle2',
			getActiveColumn: () => undefined,
		});
		const active = registerClassMatePanel({
			viewType: 'test.active2',
			getActiveColumn: () => vscode.ViewColumn.One,
		});
		assert.strictEqual(getActiveClassMatePanelColumn(), vscode.ViewColumn.One);
		active.dispose();
		assert.strictEqual(getActiveClassMatePanelColumn(), undefined);
		idle.dispose();
	});
});

describe('snapshotTabGroups', () => {
	it('把 Tab API 分组折算成决策快照(识别文本 tab)', () => {
		const textTab = { input: new vscode.TabInputText(vscode.Uri.file('/tmp/a.cpp')) } as vscode.Tab;
		const webviewTab = { input: { viewType: 'test.webview' } } as unknown as vscode.Tab;
		const groups = [
			{ viewColumn: vscode.ViewColumn.One, tabs: [textTab] } as unknown as vscode.TabGroup,
			{ viewColumn: vscode.ViewColumn.Two, tabs: [webviewTab] } as unknown as vscode.TabGroup,
			{ viewColumn: vscode.ViewColumn.Three, tabs: [] } as unknown as vscode.TabGroup,
		];
		assert.deepStrictEqual(snapshotTabGroups(groups), [
			{ viewColumn: vscode.ViewColumn.One, hasTextTab: true },
			{ viewColumn: vscode.ViewColumn.Two, hasTextTab: false },
			{ viewColumn: vscode.ViewColumn.Three, hasTextTab: false },
		]);
	});

	it('classmate-output: 虚拟文档 tab 按普通文件编辑器参与分组(hasTextTab=true)', () => {
		// 回归锚点:compile_result.txt 在 Tab API 里是 TabInputText(uri.scheme
		// 为 classmate-output),快照不按 scheme 过滤——它所在组是合法文件分组。
		const virtualTab = {
			input: new vscode.TabInputText(vscode.Uri.parse('classmate-output:///compile-result.txt')),
		} as vscode.Tab;
		const groups = [
			{ viewColumn: vscode.ViewColumn.One, tabs: [virtualTab] } as unknown as vscode.TabGroup,
		];
		assert.deepStrictEqual(snapshotTabGroups(groups), [
			{ viewColumn: vscode.ViewColumn.One, hasTextTab: true },
		]);
		// 决策层联动:面板 active 在 One 时,引用文件应复用虚拟文档所在的 Two 组。
		const panelGroups = [
			{ viewColumn: vscode.ViewColumn.One, hasTextTab: false },
			{ viewColumn: vscode.ViewColumn.Two, hasTextTab: true },
		];
		assert.strictEqual(
			resolveFileOpenTarget(vscode.ViewColumn.One, panelGroups).viewColumn,
			vscode.ViewColumn.Two
		);
	});
});
