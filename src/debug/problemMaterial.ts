import * as path from 'path';
import * as vscode from 'vscode';
import { extractPdfUri } from '../workspace/pdfExtractor';
import { decodeDiskTextFile } from '../workspace/textEncoding';
import { isProblemStatementPath } from '../workspace/workspaceContextProvider';

/**
 * 题目材料 → 题目分组键(run 条目归属,FE3 遗留 ②)。
 *
 * 读 question.md/PDF 属宿主 fs 能力,不进纯派生函数:扩展宿主写 compile/run
 * 事件时调用本模块算好 problemKey 存进事件(可选字段);viewModel/错题本等
 * 派生层优先读事件字段,缺失时回退文件名 stem(兼容旧持久化与直接构造
 * 事件的单测)。
 *
 * 材料识别口径复用 workspaceContextProvider 的题面定义(question/problem/
 * 问题/题目/作业说明/assignment × md/markdown/txt/pdf);布局依据实测样例
 * (eval-run/ws-run、每题一目录的测试集工作区):题目材料与源码同目录。
 */

/** 题目标识长度上限:分组键兼「按题目」分组的展示标签,防病态长标题。 */
const MAX_PROBLEM_KEY_LENGTH = 80;

/**
 * 源文件所在目录里的题目材料(只看本目录一层):
 * - 与源码同目录的材料才是该题的归属依据(单题工作区/每题一目录布局);
 * - 工作区根的 question.md 不冒领子目录里的多道题(与 contextPolicy 对
 *   根级题面的既有口径一致,题目分组宁可保守不误并)。
 * 同目录多份材料时确定性单选:文本优先(标题干净、读取便宜),再按路径排序。
 */
export async function findProblemMaterialUri(
    directory: vscode.Uri
): Promise<vscode.Uri | undefined> {
    let entries: [string, vscode.FileType][];
    try {
        entries = await vscode.workspace.fs.readDirectory(directory);
    } catch {
        return undefined;
    }
    const candidates = entries
        .filter(([name, type]) => type === vscode.FileType.File && isProblemStatementPath(name))
        .map(([name]) => vscode.Uri.joinPath(directory, name))
        .sort((a, b) => {
            const aPdf = path.extname(a.fsPath).toLowerCase() === '.pdf';
            const bPdf = path.extname(b.fsPath).toLowerCase() === '.pdf';
            if (aPdf !== bPdf) {
                return aPdf ? 1 : -1;
            }
            return a.fsPath.localeCompare(b.fsPath);
        });
    return candidates[0];
}

/**
 * 题目材料文本 → 标题:取首个非空行,若是 Markdown 标题则剥掉 # 前缀。
 * 纯函数,单测入口。
 */
export function extractProblemTitleFromText(text: string): string | undefined {
    for (const rawLine of text.split('\n')) {
        const line = rawLine.trim();
        if (!line) {
            continue;
        }
        const heading = line.match(/^#{1,6}\s+(.+)$/);
        const title = (heading ? heading[1] : line).replace(/\s+/g, ' ').trim();
        if (title.length > 0) {
            return title.length > MAX_PROBLEM_KEY_LENGTH
                ? title.slice(0, MAX_PROBLEM_KEY_LENGTH)
                : title;
        }
    }
    return undefined;
}

/**
 * 源文件 → 题目分组键:源文件所在目录的题目材料标题。
 * 找不到材料/读取失败/PDF 无文本层时返回 undefined,调用方必须回退
 * 现行文件名键(problemKey 语义红线)。
 */
export async function deriveProblemKeyFromMaterial(
    sourceFileUri: vscode.Uri
): Promise<string | undefined> {
    if (sourceFileUri.scheme !== 'file') {
        return undefined;
    }
    const material = await findProblemMaterialUri(
        vscode.Uri.file(path.dirname(sourceFileUri.fsPath))
    );
    if (!material) {
        return undefined;
    }
    try {
        if (path.extname(material.fsPath).toLowerCase() === '.pdf') {
            const extraction = await extractPdfUri(material);
            if (extraction.looksScanned) {
                return undefined;
            }
            // 直接取抽取文本,不走 formatPdfExtraction(那会加页数头,污染标题)。
            return extractProblemTitleFromText(extraction.text);
        }
        const bytes = await vscode.workspace.fs.readFile(material);
        return extractProblemTitleFromText(decodeDiskTextFile(bytes));
    } catch {
        // 材料读不出来(PDF 解析失败/权限等)不阻塞写事件,回退文件名键。
        return undefined;
    }
}
