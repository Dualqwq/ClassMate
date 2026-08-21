import * as assert from 'assert';
import { execSync } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it } from 'mocha';
import { runExecutable } from '../run/runner';

/**
 * 运行器测试。runner 的契约是 spawn(executablePath, []) 零参数(真实学生
 * exe 不带 argv),因此测试把 `node program.js` 包装成平台启动脚本充当
 * "学生程序":Windows 用 .cmd(走 runner 的 shell 回退),Unix 用 sh。
 * mocha 单例超时 20s,各用例的 idle/hard timeout 都压到远小于它。
 */

function findNodeExecutable(): string | undefined {
	const execPath = process.execPath.toLowerCase();
	// 在 VS Code extension host 中 process.execPath 是 Code.exe,无法执行 JS。
	if (execPath.includes('node') && !execPath.endsWith('code.exe') && !execPath.endsWith('code - insiders.exe')) {
		return process.execPath;
	}
	if (process.platform === 'win32') {
		try {
			const found = execSync('where node', { encoding: 'utf8', windowsHide: true })
				.trim()
				.split(/\r?\n/)[0];
			if (found) {
				return found;
			}
		} catch {
			// fall through
		}
	} else {
		try {
			const found = execSync('command -v node', { encoding: 'utf8' }).trim();
			if (found) {
				return found;
			}
		} catch {
			// fall through
		}
	}
	return undefined;
}

const NODE = findNodeExecutable();

async function runScript(
	script: string,
	options: Parameters<typeof runExecutable>[1] = {}
) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'classmate-runner-test-'));
	try {
		const scriptPath = path.join(dir, 'program.js');
		await fs.writeFile(scriptPath, script, 'utf8');
		let launcher: string;
		if (process.platform === 'win32') {
			launcher = path.join(dir, 'program.cmd');
			await fs.writeFile(launcher, `@echo off\r\n"${NODE}" "${scriptPath}" %*\r\n`, 'utf8');
		} else {
			launcher = path.join(dir, 'program.sh');
			await fs.writeFile(launcher, `#!/bin/sh\nexec "${NODE}" "${scriptPath}" "$@"\n`, 'utf8');
			await fs.chmod(launcher, 0o755);
		}
		return await runExecutable(launcher, options);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

describe('runExecutable', () => {
	if (!NODE) {
		it('当前环境找不到 Node 可执行文件,跳过 runner 测试', () => {
			// VS Code extension host 中 process.execPath 是 Code.exe,从 PATH 找 node 也失败。
		});
		return;
	}

	it('灌入预填 stdin,程序读到并回显', async () => {
		// runner 灌完 stdin 后不 end 管道,程序靠内部 300ms 分支输出已读内容。
		const script = `
			let data = '';
			process.stdin.on('data', (c) => { data += c; });
			setTimeout(() => { console.log('GOT:' + JSON.stringify(data)); process.exit(0); }, 300);
		`;
		const result = await runScript(script, { stdin: '5\n1 2 3 4 5', idleTimeoutMs: 2000 });
		assert.strictEqual(result.exitCode, 0);
		assert.ok(result.stdout.includes('GOT:'), `stdout: ${result.stdout}`);
		assert.ok(result.stdout.includes('5\\n1 2 3 4 5'), `stdin 未完整到达: ${result.stdout}`);
		assert.strictEqual(result.needsInteractiveInput, false);
	});

	it('stdin 末尾自动补换行(裸 token 也能被 scanf 类读取)', async () => {
		const script = `
			let data = '';
			process.stdin.on('data', (c) => { data += c; });
			setTimeout(() => { process.stdout.write(data.endsWith('\\n') ? 'NL-OK' : 'NL-MISSING'); process.exit(0); }, 300);
		`;
		const result = await runScript(script, { stdin: '42', idleTimeoutMs: 2000 });
		assert.ok(result.stdout.includes('NL-OK'), `stdout: ${result.stdout}`);
	});

	it('捕获退出码与 stderr', async () => {
		const script = `console.error('boom'); process.exit(3);`;
		const result = await runScript(script, { idleTimeoutMs: 2000 });
		assert.strictEqual(result.exitCode, 3);
		assert.ok(result.stderr.includes('boom'));
		assert.strictEqual(result.timedOut, false);
	});

	it('stdin 灌完仍等待更多输入 → 交互兜底(idle 判等输入,不挂到硬超时)', async () => {
		const script = `
			process.stdout.write('prompt> ');
			let data = '';
			process.stdin.on('data', (c) => {
				data += c;
				// 读到一行后还想再读(不 exit、不再输出)→ 模拟多轮交互程序
				if (data.split('\\n').length >= 2 && !data.includes('second')) {
					process.stdout.write('more> ');
				}
			});
			setTimeout(() => {}, 15000);
		`;
		const started = Date.now();
		const result = await runScript(script, {
			stdin: 'first',
			idleTimeoutMs: 400,
			timeoutMs: 10000,
		});
		const elapsed = Date.now() - started;
		assert.strictEqual(result.needsInteractiveInput, true);
		assert.strictEqual(result.timedOut, false);
		assert.ok(elapsed < 5000, `应在硬超时前结束,实际 ${elapsed}ms`);
		assert.ok(result.stdout.includes('prompt>'), `stdout: ${result.stdout}`);
	});

	it('持续有输出但不退出 → 硬超时(不误判交互)', async () => {
		const script = `
			setInterval(() => process.stdout.write('tick\\n'), 100);
			setTimeout(() => {}, 15000);
		`;
		const result = await runScript(script, { idleTimeoutMs: 600, timeoutMs: 900 });
		assert.strictEqual(result.timedOut, true);
		assert.strictEqual(result.needsInteractiveInput, false);
		assert.ok(result.stdout.includes('tick'));
	});

	it('onOutput 实时回调收到流式增量', async () => {
		const script = `
			process.stdout.write('a');
			setTimeout(() => { process.stdout.write('b'); process.exit(0); }, 200);
		`;
		const chunks: string[] = [];
		const result = await runScript(script, {
			idleTimeoutMs: 2000,
			onOutput: (stream, text) => {
				if (stream === 'stdout') {
					chunks.push(text);
				}
			},
		});
		assert.strictEqual(result.exitCode, 0);
		assert.ok(chunks.length >= 1);
		assert.strictEqual(chunks.join(''), 'ab');
	});
});
