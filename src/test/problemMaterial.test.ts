import * as assert from 'assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it } from 'mocha';
import * as vscode from 'vscode';
import {
    deriveProblemKeyFromMaterial,
    extractProblemTitleFromText,
    findProblemMaterialUri,
} from '../debug/problemMaterial';

async function makeTempWorkspace(files: Record<string, string>): Promise<vscode.Uri> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'classmate-problem-material-'));
    for (const [name, content] of Object.entries(files)) {
        await fs.writeFile(path.join(dir, name), content, 'utf-8');
    }
    return vscode.Uri.file(dir);
}

describe('extractProblemTitleFromText (题目材料标题提取)', () => {
    it('取首个 Markdown 标题并剥掉 # 前缀', () => {
        assert.strictEqual(
            extractProblemTitleFromText('# 求和程序(question)\n\n输入一个整数 n(1 ≤ n ≤ 1000)。'),
            '求和程序(question)'
        );
        assert.strictEqual(extractProblemTitleFromText('### 排队打水'), '排队打水');
    });

    it('首行不是标题时按普通文本行取标题', () => {
        assert.strictEqual(
            extractProblemTitleFromText('砝码称重\n\n每个砝码可以选也可以不选'),
            '砝码称重'
        );
    });

    it('跳过前导空行并归一化行内空白', () => {
        assert.strictEqual(extractProblemTitleFromText('\n\n#  两 数 之 和 \n'), '两 数 之 和');
    });

    it('空文本/纯空白返回 undefined;超长标题截断到 80 字符', () => {
        assert.strictEqual(extractProblemTitleFromText(''), undefined);
        assert.strictEqual(extractProblemTitleFromText('   \n  \n'), undefined);
        const long = '题'.repeat(100);
        const title = extractProblemTitleFromText(`# ${long}`);
        assert.ok(title);
        assert.strictEqual(title.length, 80);
    });
});

describe('findProblemMaterialUri (目录内题目材料定位)', () => {
    it('md 与 pdf 同时存在时文本优先(标题干净、读取便宜)', async () => {
        const dir = await makeTempWorkspace({
            'question.md': '# A',
            'question.pdf': 'not a real pdf',
        });
        try {
            const material = await findProblemMaterialUri(dir);
            assert.ok(material);
            assert.strictEqual(path.basename(material.fsPath), 'question.md');
        } finally {
            await fs.rm(dir.fsPath, { recursive: true, force: true });
        }
    });

    it('只认题面文件名:README/main.cpp 不算题目材料', async () => {
        const dir = await makeTempWorkspace({
            'README.md': '# not a question',
            'main.cpp': 'int main() {}',
        });
        try {
            assert.strictEqual(await findProblemMaterialUri(dir), undefined);
        } finally {
            await fs.rm(dir.fsPath, { recursive: true, force: true });
        }
    });

    it('目录不存在时返回 undefined(不抛错)', async () => {
        const missing = vscode.Uri.file(
            path.join(os.tmpdir(), `classmate-missing-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`)
        );
        assert.strictEqual(await findProblemMaterialUri(missing), undefined);
    });
});

describe('deriveProblemKeyFromMaterial (源文件 → 题目材料键)', () => {
    it('源文件所在目录有 question.md 时取标题作题目键', async () => {
        const dir = await makeTempWorkspace({
            'main.cpp': 'int main() {}',
            'question.md': '# 求和程序(question)\n\n输入一个整数 n(1 ≤ n ≤ 1000)。',
        });
        try {
            const key = await deriveProblemKeyFromMaterial(vscode.Uri.joinPath(dir, 'main.cpp'));
            assert.strictEqual(key, '求和程序(question)');
        } finally {
            await fs.rm(dir.fsPath, { recursive: true, force: true });
        }
    });

    it('材料只在父目录时不冒领(返回 undefined,红线:找不到材料回退文件名键)', async () => {
        const dir = await makeTempWorkspace({ 'question.md': '# 根目录的题' });
        try {
            await fs.mkdir(path.join(dir.fsPath, 'src'));
            await fs.writeFile(path.join(dir.fsPath, 'src', 'main.cpp'), 'int main() {}');
            const key = await deriveProblemKeyFromMaterial(
                vscode.Uri.joinPath(dir, 'src', 'main.cpp')
            );
            assert.strictEqual(key, undefined);
        } finally {
            await fs.rm(dir.fsPath, { recursive: true, force: true });
        }
    });

    it('无材料/非 file scheme 返回 undefined', async () => {
        const dir = await makeTempWorkspace({ 'main.cpp': 'int main() {}' });
        try {
            assert.strictEqual(
                await deriveProblemKeyFromMaterial(vscode.Uri.joinPath(dir, 'main.cpp')),
                undefined
            );
            assert.strictEqual(
                await deriveProblemKeyFromMaterial(vscode.Uri.parse('untitled:Untitled-1')),
                undefined
            );
        } finally {
            await fs.rm(dir.fsPath, { recursive: true, force: true });
        }
    });

    it('解析失败的 PDF 材料不抛错,返回 undefined(不阻塞事件写入)', async () => {
        const dir = await makeTempWorkspace({
            'main.cpp': 'int main() {}',
            'question.pdf': 'definitely not a pdf body',
        });
        try {
            const key = await deriveProblemKeyFromMaterial(vscode.Uri.joinPath(dir, 'main.cpp'));
            assert.strictEqual(key, undefined);
        } finally {
            await fs.rm(dir.fsPath, { recursive: true, force: true });
        }
    });
});
