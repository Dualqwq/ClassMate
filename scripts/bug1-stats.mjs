#!/usr/bin/env node

import { createRequire } from 'module';
import { promises as fs } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const { summarizeBug1Run, formatBug1StatsMarkdown } = require('../out/eval/bug1Stats.js');
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));

function usage() {
	return [
		'用法:',
		'  node scripts/bug1-stats.mjs --input <checkpoint.json> [--markdown out.md]',
		'',
		'选项:',
		'  --input     live eval 生成的 schemaVersion=2 checkpoint',
		'  --markdown  统计报告同时写入该 Markdown 文件(可选)',
		'',
		'示例(从 code/classmate 运行):',
		'  node scripts/bug1-stats.mjs --input ../../log/bug1-qual-run12.json',
		'  node scripts/bug1-stats.mjs --input ../../log/bug1-qual-run12.json --markdown ../../log/bug1-qual-run12.stats.md',
	].join('\n');
}

async function main() {
	const args = process.argv.slice(2);
	const inputIndex = args.indexOf('--input');
	const markdownIndex = args.indexOf('--markdown');
	if (inputIndex === -1 || !args[inputIndex + 1]) {
		console.error(usage());
		process.exitCode = 1;
		return;
	}
	const inputPath = path.resolve(scriptDirectory, args[inputIndex + 1]);
	const checkpoint = JSON.parse(await fs.readFile(inputPath, 'utf8'));
	if (!Array.isArray(checkpoint?.results)) {
		console.error(`输入不是有效的 checkpoint(缺少 results 数组): ${inputPath}`);
		process.exitCode = 1;
		return;
	}
	const report = formatBug1StatsMarkdown(summarizeBug1Run(checkpoint.results));
	const header = [
		`# ${path.basename(inputPath)}`,
		`- provider: ${checkpoint.provider ?? '未知'} / model: ${checkpoint.model ?? '未知'}`,
		`- startedAt: ${checkpoint.startedAt ?? '未知'}`,
		'',
	].join('\n');
	console.log(header + report);
	if (markdownIndex !== -1 && args[markdownIndex + 1]) {
		const outputPath = path.resolve(process.cwd(), args[markdownIndex + 1]);
		await fs.writeFile(outputPath, header + report + '\n', 'utf8');
		console.error(`\n统计报告已写入: ${outputPath}`);
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
