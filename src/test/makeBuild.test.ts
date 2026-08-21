import * as assert from 'assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it } from 'mocha';
import * as vscode from 'vscode';
import { detectMakeTool, findRootMakefile } from '../compiler/compilerService';
import { CompileOutputProvider, COMPILE_OUTPUT_URI } from '../compiler/outputPanel';
import { getKnowledgeConcept, matchErrorToKnowledge } from '../error/errorKnowledgeMap';

describe('make tool detection', () => {
    it('prefers make when make is available', () => {
        const tool = detectMakeTool(() => true);
        assert.strictEqual(tool, 'make');
    });

    it('falls back to mingw32-make when make is missing', () => {
        const tool = detectMakeTool((command) => command.startsWith('mingw32-make'));
        assert.strictEqual(tool, 'mingw32-make');
    });

    it('tries make before mingw32-make', () => {
        const tried: string[] = [];
        detectMakeTool((command) => {
            tried.push(command);
            return false;
        });
        const makeIndex = tried.findIndex((command) => command === 'make');
        const mingwIndex = tried.findIndex((command) => command === 'mingw32-make');
        assert.ok(makeIndex !== -1 && mingwIndex !== -1);
        assert.ok(makeIndex < mingwIndex);
    });

    it('returns undefined when neither make nor mingw32-make exists', () => {
        const tool = detectMakeTool(() => false);
        assert.strictEqual(tool, undefined);
    });
});

describe('root Makefile detection', () => {
    async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'classmate-make-'));
        try {
            await run(dir);
        } finally {
            await fs.rm(dir, { recursive: true, force: true });
        }
    }

    it('finds a Makefile placed at the workspace root', async () => {
        await withTempDir(async (dir) => {
            await fs.writeFile(path.join(dir, 'Makefile'), 'all:\n\techo ok\n');
            const found = await findRootMakefile(dir);
            assert.strictEqual(found, path.join(dir, 'Makefile'));
        });
    });

    it('matches the makefile name case-insensitively', async () => {
        await withTempDir(async (dir) => {
            await fs.writeFile(path.join(dir, 'MAKEFILE'), 'all:\n\techo ok\n');
            const found = await findRootMakefile(dir);
            assert.ok(found);
            assert.strictEqual(path.basename(found), 'MAKEFILE');
        });
    });

    it('does not search subdirectories', async () => {
        await withTempDir(async (dir) => {
            const subDir = path.join(dir, 'src');
            await fs.mkdir(subDir);
            await fs.writeFile(path.join(subDir, 'Makefile'), 'all:\n\techo ok\n');
            const found = await findRootMakefile(dir);
            assert.strictEqual(found, undefined);
        });
    });

    it('returns undefined for a directory without a Makefile', async () => {
        await withTempDir(async (dir) => {
            await fs.writeFile(path.join(dir, 'main.cpp'), 'int main() { return 0; }\n');
            const found = await findRootMakefile(dir);
            assert.strictEqual(found, undefined);
        });
    });

    it('returns undefined for a missing directory', async () => {
        const found = await findRootMakefile(path.join(os.tmpdir(), 'classmate-make-does-not-exist'));
        assert.strictEqual(found, undefined);
    });
});

describe('compile output virtual document timing', () => {
    it('pre-creates basic info immediately, then force-refreshes full output once', () => {
        const provider = new CompileOutputProvider();
        const changes: string[] = [];
        provider.onDidChange((uri) => changes.push(uri.toString()));

        // Phase 1 (#9): make starts -> the virtual file is created at once
        // with basic info so the user sees the build has begun.
        provider.set(COMPILE_OUTPUT_URI, 'ClassMate 编译已开始…');
        assert.strictEqual(provider.provideTextDocumentContent(COMPILE_OUTPUT_URI), 'ClassMate 编译已开始…');

        // Phase 2 (#9): make ends -> one forced refresh replaces the content
        // with the full pass/fail output.
        const full = 'Built with: make (default target)\nExit code: 0\nDuration: 123ms\n';
        provider.set(COMPILE_OUTPUT_URI, full);

        assert.deepStrictEqual(changes, [COMPILE_OUTPUT_URI.toString(), COMPILE_OUTPUT_URI.toString()]);
        assert.strictEqual(provider.provideTextDocumentContent(COMPILE_OUTPUT_URI), full);
        assert.strictEqual(provider.getLine(COMPILE_OUTPUT_URI, 0), 'Built with: make (default target)');
        assert.strictEqual(provider.getLine(COMPILE_OUTPUT_URI, 1), 'Exit code: 0');
    });
});

describe('make error knowledge entries', () => {
    it('maps a "missing separator" stderr sample to make_missing_separator', () => {
        const stderr = 'Makefile:2: *** missing separator.  Stop.';
        const matches = matchErrorToKnowledge(stderr);
        assert.ok(matches.some((match) => match.tag === 'make_missing_separator'));
        const concept = getKnowledgeConcept('make_missing_separator');
        assert.ok(concept);
        assert.ok(concept.summary.length > 0);
    });

    it('maps a "No rule to make target" stderr sample to make_no_rule', () => {
        const stderr = "make: *** No rule to make target 'main.o', needed by 'app'.  Stop.";
        const matches = matchErrorToKnowledge(stderr);
        assert.ok(matches.some((match) => match.tag === 'make_no_rule'));
        const concept = getKnowledgeConcept('make_no_rule');
        assert.ok(concept);
        assert.ok(concept.summary.length > 0);
    });

    it('still matches g++ diagnostics emitted through make recipes', () => {
        const stderr = "main.cpp:5:5: error: 'x' was not declared in this scope\nmake: *** [Makefile:4: main.o] Error 1";
        const matches = matchErrorToKnowledge(stderr);
        assert.ok(matches.some((match) => match.tag === 'undeclared_identifier'));
    });
});

describe('bundled make setup guide resource', () => {
    it('is readable from the extension install directory in dev mode', async () => {
        const extension = vscode.extensions.getExtension('undefined_publisher.classmate');
        assert.ok(extension);
        const guideUri = vscode.Uri.joinPath(extension.extensionUri, 'resources', 'make-setup-guide.md');
        const bytes = await vscode.workspace.fs.readFile(guideUri);
        const text = Buffer.from(bytes).toString('utf8');
        assert.ok(text.includes('mingw32-make'));
        assert.ok(text.includes('Makefile'));
    });
});
