#!/usr/bin/env node

import { createRequire } from 'module';
import { promises as fs } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const { startBug1ReviewServer } = require('../out/eval/bug1ReviewServer.js');
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));

function usage() {
	return [
		'用法:',
		'  npm run eval:review -- --input <checkpoint.json> [--judgments <judgments.json>] [--port 4318]',
		'',
		'选项:',
		'  --input       live eval 生成的 schemaVersion=2 checkpoint',
		'  --judgments   判卷保存路径；默认与 input 同目录并加 .judgments.json',
		'  --port        localhost 端口；默认随机可用端口',
		'  --help        显示帮助',
	].join('\n');
}

function parseArgs(argv) {
	const values = {};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === '--help' || arg === '-h') {
			values.help = true;
			continue;
		}
		if (!['--input', '--judgments', '--port'].includes(arg)) {
			throw new Error(`未知参数: ${arg}`);
		}
		const value = argv[index + 1];
		if (!value || value.startsWith('--')) {
			throw new Error(`${arg} 缺少参数值。`);
		}
		values[arg.slice(2)] = value;
		index += 1;
	}
	return values;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		console.log(usage());
		return;
	}
	if (!args.input) {
		throw new Error(`--input 是必填项。\n\n${usage()}`);
	}
	const checkpointPath = path.resolve(process.cwd(), args.input);
	const parsed = path.parse(checkpointPath);
	const judgmentsPath = args.judgments
		? path.resolve(process.cwd(), args.judgments)
		: path.join(parsed.dir, `${parsed.name}.judgments.json`);
	const port = args.port === undefined ? 0 : Number(args.port);
	if (!Number.isInteger(port) || port < 0 || port > 65535) {
		throw new Error('--port 必须是 0 到 65535 的整数。');
	}
	const uiHtml = await fs.readFile(
		path.join(scriptDirectory, 'bug1-review.html'),
		'utf8'
	);
	const server = await startBug1ReviewServer({
		checkpointPath,
		judgmentsPath,
		port,
		uiHtml,
	});

	console.log('ClassMate bug1 人工判卷已启动。');
	console.log(`判卷页面: ${server.url}`);
	console.log(`输入结果: ${checkpointPath}`);
	console.log(`判卷保存: ${judgmentsPath}`);
	console.log('完成后在此窗口按 Ctrl+C 停止。');

	let closing = false;
	const close = async () => {
		if (closing) {
			return;
		}
		closing = true;
		await server.close();
	};
	process.once('SIGINT', () => void close().then(() => process.exit(0)));
	process.once('SIGTERM', () => void close().then(() => process.exit(0)));
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
