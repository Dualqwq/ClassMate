import * as assert from 'assert';
import { describe, it } from 'mocha';
import * as vscode from 'vscode';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    getWorkspaceFileKind,
    isBuildFilePath,
    isProblemStatementPath,
    selectProblemFile,
    selectQuestionFile,
} from '../workspace/workspaceContextProvider';
import { WorkspaceContextLoader } from '../workspace/workspaceContextLoader';
import { formatPdfExtraction } from '../workspace/pdfExtractor';

describe('question.md selection', () => {
    it('recognizes common Chinese and English problem statement names', () => {
        assert.strictEqual(isProblemStatementPath('/workspace/question.md'), true);
        assert.strictEqual(isProblemStatementPath('/workspace/problem.txt'), true);
        assert.strictEqual(isProblemStatementPath('/workspace/问题.md'), true);
        assert.strictEqual(isProblemStatementPath('/workspace/题目.pdf'), true);
        assert.strictEqual(isProblemStatementPath('/workspace/作业说明.markdown'), true);
        assert.strictEqual(isProblemStatementPath('/workspace/question-answer.md'), false);
        assert.strictEqual(
            getWorkspaceFileKind(vscode.Uri.file('/workspace/问题.md')),
            'question'
        );
    });

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

    it('selects the nearest question file from an ancestor directory', () => {
        const rootQuestion = vscode.Uri.file('/workspace/question.md');
        const assignmentQuestion = vscode.Uri.file('/workspace/homework/question.md');
        const active = vscode.Uri.file('/workspace/homework/src/main.cpp');
        assert.strictEqual(
            selectProblemFile([rootQuestion, assignmentQuestion], [], active)?.fsPath,
            assignmentQuestion.fsPath
        );
    });

    it('chooses the closest problem marker when several assignments exist', () => {
        const nearby = vscode.Uri.file('/workspace/course/week-2/问题.md');
        const farther = vscode.Uri.file('/workspace/course/week-1/question.md');
        const active = vscode.Uri.file('/workspace/course/week-2/src/main.cpp');
        assert.strictEqual(
            selectProblemFile([farther, nearby], [], active)?.fsPath,
            nearby.fsPath
        );
    });
});

describe('Makefile workspace context', () => {
    it('recognizes common Makefile names and .mk files as build files', () => {
        assert.strictEqual(isBuildFilePath('/workspace/Makefile'), true);
        assert.strictEqual(isBuildFilePath('/workspace/makefile'), true);
        assert.strictEqual(isBuildFilePath('/workspace/GNUmakefile'), true);
        assert.strictEqual(isBuildFilePath('/workspace/rules.mk'), true);
        assert.strictEqual(isBuildFilePath('/workspace/main.cpp'), false);
        assert.strictEqual(
            getWorkspaceFileKind(vscode.Uri.file('/workspace/Makefile')),
            'build'
        );
    });

    it('recognizes .in, .out, and .ans sample files as readable text', () => {
        assert.strictEqual(
            getWorkspaceFileKind(vscode.Uri.file('/workspace/exp1.in')),
            'text'
        );
        assert.strictEqual(
            getWorkspaceFileKind(vscode.Uri.file('/workspace/exp1.out')),
            'text'
        );
        assert.strictEqual(
            getWorkspaceFileKind(vscode.Uri.file('/workspace/0.ans')),
            'text'
        );
    });

    it('loads Makefile text selected from the validated workspace catalog', async () => {
        const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'classmate-makefile-'));
        const makefilePath = path.join(tempDirectory, 'Makefile');
        const content = 'app: main.cpp\n\tg++ main.cpp -o app\n';
        try {
            await fs.writeFile(makefilePath, content, 'utf8');
            const stat = await fs.stat(makefilePath);
            const uri = vscode.Uri.file(makefilePath);
            const loaded = await new WorkspaceContextLoader().load({
                files: [{
                    path: 'Makefile',
                    uri: uri.toString(),
                    kind: 'build',
                    size: stat.size,
                    modifiedAt: stat.mtimeMs,
                }],
                questionFiles: [],
            }, [{
                source: 'workspace',
                target: 'Makefile',
                required: true,
                reason: 'Test Makefile loading.',
            }]);

            assert.strictEqual(loaded.length, 1);
            assert.strictEqual(loaded[0].kind, 'build');
            assert.strictEqual(loaded[0].content, content);
        } finally {
            await fs.rm(tempDirectory, { recursive: true, force: true });
        }
    });

    it('loads more than five validated workspace files', async () => {
        const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'classmate-many-files-'));
        try {
            const paths = Array.from({ length: 8 }, (_, index) =>
                path.join(tempDirectory, `file-${index}.cpp`)
            );
            await Promise.all(paths.map((filePath, index) =>
                fs.writeFile(filePath, `int value${index} = ${index};\n`, 'utf8')
            ));
            const files = await Promise.all(paths.map(async (filePath, index) => {
                const stat = await fs.stat(filePath);
                const uri = vscode.Uri.file(filePath);
                return {
                    path: `file-${index}.cpp`,
                    uri: uri.toString(),
                    kind: 'code' as const,
                    size: stat.size,
                    modifiedAt: stat.mtimeMs,
                };
            }));
            const loaded = await new WorkspaceContextLoader().load({
                files,
                questionFiles: [],
            }, files.map((file) => ({
                source: 'workspace' as const,
                target: file.path,
                required: true,
                reason: 'Test loading without a fixed file-count limit.',
            })));

            assert.strictEqual(loaded.length, 8);
        } finally {
            await fs.rm(tempDirectory, { recursive: true, force: true });
        }
    });
});
