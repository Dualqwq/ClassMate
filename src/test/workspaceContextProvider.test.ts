import * as assert from 'assert';
import { describe, it } from 'mocha';
import * as vscode from 'vscode';
import { selectProblemFile, selectQuestionFile } from '../workspace/workspaceContextProvider';
import { formatPdfExtraction } from '../workspace/pdfExtractor';

describe('question.md selection', () => {
    it('prefers question.md beside the active source file', () => {
        const rootQuestion = vscode.Uri.file('/workspace/question.md');
        const assignmentQuestion = vscode.Uri.file('/workspace/homework-01/question.md');
        const activeSource = vscode.Uri.file('/workspace/homework-01/main.cpp');
        assert.strictEqual(
            selectQuestionFile([rootQuestion, assignmentQuestion], activeSource)?.fsPath,
            assignmentQuestion.fsPath
        );
    });

    it('uses a deterministic fallback when no nearby question exists', () => {
        const first = vscode.Uri.file('/workspace/a/question.md');
        const second = vscode.Uri.file('/workspace/b/question.md');
        assert.strictEqual(
            selectQuestionFile([second, first], vscode.Uri.file('/workspace/c/main.cpp'))?.fsPath,
            first.fsPath
        );
    });
});

describe('question.pdf fallback', () => {
    it('prefers nearby PDF over unrelated Markdown', () => {
        const markdown = vscode.Uri.file('/workspace/other/question.md');
        const pdf = vscode.Uri.file('/workspace/homework/question.pdf');
        const active = vscode.Uri.file('/workspace/homework/main.cpp');
        assert.strictEqual(selectProblemFile([markdown], [pdf], active)?.fsPath, pdf.fsPath);
    });

    it('reports scanned PDFs instead of pretending text was extracted', () => {
        assert.ok(formatPdfExtraction({
            text: '', pageCount: 2, truncated: false, looksScanned: true,
        }).includes('requires OCR'));
    });
});
