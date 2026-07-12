import * as assert from 'assert';
import { describe, it } from 'mocha';
import { resolveChatPanelColumn } from '../ui/ChatPanel';
import * as vscode from 'vscode';

// These tests mirror the decision logic in ChatPanel.createOrShow without
// depending on live VS Code UI state.

describe('ChatPanel target column resolution', () => {
    it('opens in column Two when there is no split view', () => {
        assert.strictEqual(resolveChatPanelColumn(1, undefined), vscode.ViewColumn.Two);
        assert.strictEqual(resolveChatPanelColumn(1, vscode.ViewColumn.One), vscode.ViewColumn.Two);
        assert.strictEqual(resolveChatPanelColumn(1, vscode.ViewColumn.Two), vscode.ViewColumn.Two);
    });

    it('avoids covering the active source editor when split', () => {
        // Active editor is in column Two -> panel should go to column One.
        assert.strictEqual(resolveChatPanelColumn(2, vscode.ViewColumn.Two), vscode.ViewColumn.One);
        assert.strictEqual(resolveChatPanelColumn(3, vscode.ViewColumn.Two), vscode.ViewColumn.One);
    });

    it('falls back to column Two when active editor is already in column One', () => {
        assert.strictEqual(resolveChatPanelColumn(2, vscode.ViewColumn.One), vscode.ViewColumn.Two);
        assert.strictEqual(resolveChatPanelColumn(3, vscode.ViewColumn.One), vscode.ViewColumn.Two);
    });

    it('falls back to column Two when active column is unknown', () => {
        assert.strictEqual(resolveChatPanelColumn(2, undefined), vscode.ViewColumn.Two);
    });
});
