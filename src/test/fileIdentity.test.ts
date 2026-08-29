import * as assert from 'assert';
import { describe, it } from 'mocha';
import {
    deriveFileIdentity,
    formatFileDisplayPath,
    normalizeFilePath,
    sameProgramFile,
} from '../debug/fileIdentity';

/**
 * 文件身份与展示路径 helper 单测(2026-08-29 跨目录撞名修复的底层口径)。
 * 覆盖:双 URI 形态归一、盘符/大小写折叠、异目录同 stem 分离、相对路径
 * (无目录证据)stem 兜底、工作区相对/根外绝对/根未知原名三档 label。
 */

describe('normalizeFilePath', () => {
    it('file:// URI percent 解码 + 盘符路径剥前导斜杠 + 反斜杠统一', () => {
        assert.strictEqual(normalizeFilePath('file:///c%3A/ws/a.cpp'), 'c:/ws/a.cpp');
        assert.strictEqual(normalizeFilePath('file:///C%3A/ws/a.cpp'), 'C:/ws/a.cpp');
        assert.strictEqual(
            normalizeFilePath('file:///c%3A/Users/u/%E6%99%BA%E7%90%86%E6%9D%AF/a.cpp'),
            'c:/Users/u/智理杯/a.cpp'
        );
        assert.strictEqual(normalizeFilePath('C:\\ws\\a.cpp'), 'C:/ws/a.cpp');
        assert.strictEqual(normalizeFilePath('/home/u/a.cpp'), '/home/u/a.cpp');
        // 畸形 percent 序列按原样保留,不抛错。
        assert.strictEqual(normalizeFilePath('file:///c%3A/ws/a%2.cpp'), 'c:/ws/a%2.cpp');
    });
});

describe('deriveFileIdentity', () => {
    it('目录 + stem;无文件名/空 stem 返回 undefined', () => {
        assert.deepStrictEqual(deriveFileIdentity('file:///c%3A/ws/a.cpp'), {
            dir: 'c:/ws',
            stem: 'a',
        });
        assert.deepStrictEqual(deriveFileIdentity('c:\\ws\\problem1\\a.cpp'), {
            dir: 'c:/ws/problem1',
            stem: 'a',
        });
        assert.deepStrictEqual(deriveFileIdentity('b.h'), { dir: '', stem: 'b' });
        assert.strictEqual(deriveFileIdentity(undefined), undefined);
        assert.strictEqual(deriveFileIdentity('file:///c%3A/ws/'), undefined);
    });

    it('stem 口径与 deriveProblemKey 一致(点前非空才去扩展名)', () => {
        assert.deepStrictEqual(deriveFileIdentity('file:///w/.gitignore'), {
            dir: '/w',
            stem: '.gitignore',
        });
    });
});

describe('sameProgramFile(同目录 + 同 stem,目录证据可信才区分)', () => {
    it('同一文件双形态(纯路径 vs file://、盘符/大小写差异)归并', () => {
        assert.strictEqual(sameProgramFile('c:\\ws\\a.cpp', 'file:///c%3A/ws/a.exe'), true);
        assert.strictEqual(sameProgramFile('C:\\WS\\A.CPP', 'file:///c%3A/ws/a.cpp'), true);
        assert.strictEqual(sameProgramFile('c:/ws/a.cpp', 'c:\\ws\\a.cpp'), true);
    });

    it('异目录同 stem 不归并(problem1/a.cpp vs problem2/a.cpp)', () => {
        assert.strictEqual(
            sameProgramFile('c:\\ws\\problem1\\a.cpp', 'file:///c%3A/ws/problem2/a.exe'),
            false
        );
        assert.strictEqual(
            sameProgramFile('file:///c%3A/ws/problem1/a.cpp', 'file:///c%3A/ws/problem2/a.cpp'),
            false
        );
    });

    it('无目录证据(裸名/相对目录)退回 stem 兜底,与旧版 stem 归并兼容', () => {
        assert.strictEqual(sameProgramFile('a.cpp', 'file:///c%3A/ws/a.exe'), true);
        assert.strictEqual(sameProgramFile('src/main.cpp', 'file:///c%3A/ws/src/main.exe'), true);
        // 无目录证据的一侧不反驳,但另一侧不同 stem 仍不归并。
        assert.strictEqual(sameProgramFile('b.cpp', 'file:///c%3A/ws/a.exe'), false);
    });

    it('POSIX 绝对目录大小写敏感,Windows 目录大小写不敏感', () => {
        assert.strictEqual(sameProgramFile('/home/u/a.cpp', '/home/U/a.exe'), false);
        assert.strictEqual(sameProgramFile('c:/ws/a.cpp', 'C:/WS/a.exe'), true);
    });

    it('任一侧解析不出身份返回 false', () => {
        assert.strictEqual(sameProgramFile(undefined, 'file:///c%3A/ws/a.cpp'), false);
        assert.strictEqual(sameProgramFile('file:///c%3A/ws/', 'a.cpp'), false);
    });
});

describe('formatFileDisplayPath(工作区相对 / 根外绝对 / 根未知原名)', () => {
    const ROOT = 'c:\\ws';

    it('根内文件 → 相对根路径(正斜杠,保留文件自身大小写)', () => {
        assert.strictEqual(formatFileDisplayPath('file:///c%3A/ws/problem1/a.cpp', ROOT), 'problem1/a.cpp');
        assert.strictEqual(formatFileDisplayPath('c:\\ws\\problem2\\a.cpp', ROOT), 'problem2/a.cpp');
        // 根大小写差异不影响相对化。
        assert.strictEqual(formatFileDisplayPath('file:///c%3A/ws/problem1/a.cpp', 'C:\\WS'), 'problem1/a.cpp');
        // 根尾随分隔符容忍。
        assert.strictEqual(formatFileDisplayPath('c:\\ws\\a.cpp', 'c:\\ws\\'), 'a.cpp');
    });

    it('根外文件 → 规范化绝对路径(系统头/其他盘诚实展示)', () => {
        assert.strictEqual(
            formatFileDisplayPath('c:\\mingw\\include\\bits\\stdc++.h', ROOT),
            'c:/mingw/include/bits/stdc++.h'
        );
        assert.strictEqual(formatFileDisplayPath('file:///d%3A/other/b.cpp', ROOT), 'd:/other/b.cpp');
    });

    it('相对路径文件(无目录证据)原样展示', () => {
        assert.strictEqual(formatFileDisplayPath('b.h', ROOT), 'b.h');
        assert.strictEqual(formatFileDisplayPath('src/main.cpp', ROOT), 'src/main.cpp');
    });

    it('根未知 → 原名(basename),沿用旧 label 行为', () => {
        assert.strictEqual(formatFileDisplayPath('file:///c%3A/ws/problem1/a.cpp'), 'a.cpp');
        assert.strictEqual(formatFileDisplayPath('c:\\ws\\problem2\\a.cpp'), 'a.cpp');
        assert.strictEqual(formatFileDisplayPath('b.h'), 'b.h');
    });

    it('无引用返回 undefined', () => {
        assert.strictEqual(formatFileDisplayPath(undefined, ROOT), undefined);
    });
});
