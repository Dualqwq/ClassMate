import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { describe, it } from 'mocha';
import { RunService } from '../run/runService';
import { checkExecutableAvailability } from '../run/executableAvailability';
import type { ExecutableAvailability, RunExtensionToWebviewMessage, RunPanelSnapshot } from '../run/types';

interface ServiceInternals {
	_selectedExecutable: NonNullable<RunPanelSnapshot['executable']>;
	_running: boolean;
	_discoverInterval?: ReturnType<typeof setInterval>;
	_autoDiscoverTick(): Promise<void>;
	_store: { readAll(): Promise<RunPanelSnapshot['history']> };
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

async function fixture(
	body: (service: RunService, inner: ServiceInternals, exe: string, root: string) => Promise<void>,
	checkExecutable?: typeof checkExecutableAvailability
): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'classmate-run-path-'));
	const exe = path.join(root, '中文 selected.exe');
	const service = new RunService({ globalStorageUri: vscode.Uri.file(root) } as vscode.ExtensionContext, { checkExecutable });
	const inner = service as unknown as ServiceInternals;
	try {
		await fs.writeFile(exe, 'fixture');
		// picker 的选择结果；实际文件检查、维护周期、快照和运行守卫不替换。
		inner._selectedExecutable = { path: exe, source: 'user-picked', availability: 'available' };
		await body(service, inner, exe, root);
	} finally {
		service.detach();
		await fs.rm(root, { recursive: true, force: true });
	}
}

async function attach(service: RunService): Promise<RunExtensionToWebviewMessage[]> {
	const messages: RunExtensionToWebviewMessage[] = [];
	service.attach({ postMessage: (message) => messages.push(message) });
	await service.handleMessage({ type: 'run:requestState' });
	messages.length = 0;
	return messages;
}

function lastState(messages: RunExtensionToWebviewMessage[]): RunPanelSnapshot | undefined {
	return messages.filter((m): m is Extract<RunExtensionToWebviewMessage, { type: 'run:state' }> => m.type === 'run:state').at(-1)?.state;
}

describe('Run 已选路径有效性', () => {
	it('刷新状态发现删除且保留选择，同路径重建后自动恢复', async () => {
		await fixture(async (service, _inner, exe) => {
			await fs.unlink(exe);
			const missing = await service.buildSnapshot();
			assert.strictEqual(missing.executable?.path, exe);
			assert.strictEqual(missing.executable?.availability, 'missing');
			await fs.writeFile(exe, 'rebuilt');
			assert.strictEqual((await service.buildSnapshot()).executable?.availability, 'available');
		});
	});

	it('真实维护周期无需点击运行即可标记删除，detach 清除计时器', async () => {
		await fixture(async (service, inner, exe) => {
			const messages = await attach(service);
			assert.ok(inner._discoverInterval);
			await fs.unlink(exe);
			await new Promise((resolve) => setTimeout(resolve, 2300));
			assert.strictEqual(lastState(messages)?.executable?.availability, 'missing');
			service.detach();
			assert.strictEqual(inner._discoverInterval, undefined);
		});
	});

	it('只检查原路径：外部目录文件移动后即失效，不改选同名文件；重建后恢复', async () => {
		await fixture(async (service, inner, exe, root) => {
			const messages = await attach(service);
			const other = path.join(root, 'other');
			await fs.mkdir(other);
			await fs.rename(exe, path.join(other, path.basename(exe)));
			await inner._autoDiscoverTick();
			assert.strictEqual(lastState(messages)?.executable?.path, exe);
			assert.strictEqual(lastState(messages)?.executable?.availability, 'missing');
			await fs.writeFile(exe, 'rebuilt');
			await inner._autoDiscoverTick();
			assert.strictEqual(lastState(messages)?.executable?.availability, 'available');
			assert.strictEqual(lastState(messages)?.lastStdin, '');
			assert.deepStrictEqual(lastState(messages)?.history, []);
		});
	});

	it('文件被同名目录代替也视为失效', async () => {
		await fixture(async (service, _inner, exe) => {
			await fs.unlink(exe);
			await fs.mkdir(exe);
			assert.strictEqual((await service.buildSnapshot()).executable?.availability, 'missing');
		});
	});

	it('无状态变化不广播，避免周期性重置面板', async () => {
		await fixture(async (service, inner) => {
			const messages = await attach(service);
			await inner._autoDiscoverTick();
			await inner._autoDiscoverTick();
			assert.deepStrictEqual(messages, []);
		});
	});

	it('运行中暂停维护，结束后的状态立即复检', async () => {
		await fixture(async (service, inner, exe) => {
			const messages = await attach(service);
			inner._running = true;
			await fs.unlink(exe);
			await inner._autoDiscoverTick();
			assert.deepStrictEqual(messages, []);
			inner._running = false;
			await service.pushState();
			assert.strictEqual(lastState(messages)?.executable?.availability, 'missing');
		});
	});

	it('点击运行前删除仍被拦截，保留路径和 stdin，不写运行历史', async () => {
		await fixture(async (service, _inner, exe) => {
			await fs.unlink(exe);
			await service.run('42\n');
			const state = await service.buildSnapshot();
			assert.strictEqual(state.executable?.path, exe);
			assert.strictEqual(state.executable?.availability, 'missing');
			assert.strictEqual(state.lastStdin, '42\n');
			assert.strictEqual(state.running, false);
			assert.deepStrictEqual(state.history, []);
		});
	});

	it('重新 attach 时立即发现关闭期间删除的文件', async () => {
		await fixture(async (service, _inner, exe) => {
			await attach(service);
			service.detach();
			await fs.unlink(exe);
			const messages: RunExtensionToWebviewMessage[] = [];
			service.attach({ postMessage: (m) => messages.push(m) });
			await service.handleMessage({ type: 'run:requestState' });
			assert.strictEqual(lastState(messages)?.executable?.availability, 'missing');
		});
	});

	it('旧路径慢检查不能覆盖新选择，并发同路径检查只执行一次', async () => {
		const first = deferred<ExecutableAvailability>();
		const entered = deferred<void>();
		let oldPath = '';
		let calls = 0;
		await fixture(async (service, inner, exe, root) => {
			oldPath = exe;
			const a = service.buildSnapshot();
			await entered.promise;
			const b = service.buildSnapshot();
			// 让第二个快照跨过异步历史读取，合并到同一次路径检查。
			await new Promise((resolve) => setTimeout(resolve, 20));
			assert.strictEqual(calls, 1);
			const newPath = path.join(root, 'B.exe');
			inner._selectedExecutable = { path: newPath, source: 'user-picked', availability: 'unknown' };
			assert.strictEqual((await service.buildSnapshot()).executable?.availability, 'available');
			first.resolve('missing');
			await Promise.all([a, b]);
			assert.strictEqual(inner._selectedExecutable.path, newPath);
			assert.strictEqual(inner._selectedExecutable.availability, 'available');
		}, async (candidate) => {
			if (candidate !== oldPath) { return 'available'; }
			calls++;
			entered.resolve();
			return first.promise;
		});
	});

	it('detach 后未完成的检查不得发送状态', async () => {
		const gate = deferred<ExecutableAvailability>();
		const entered = deferred<void>();
		let blocked = false;
		await fixture(async (service, inner) => {
			const messages = await attach(service);
			blocked = true;
			const tick = inner._autoDiscoverTick();
			await entered.promise;
			service.detach();
			gate.resolve('missing');
			await tick;
			assert.deepStrictEqual(messages, []);
		}, async () => {
			if (!blocked) { return 'available'; }
			entered.resolve();
			return gate.promise;
		});
	});

	it('慢历史快照不能在新状态之后倒序发布', async () => {
		await fixture(async (service, inner) => {
			const messages = await attach(service);
			const gate = deferred<RunPanelSnapshot['history']>();
			let first = true;
			inner._store.readAll = () => {
				if (first) { first = false; return gate.promise; }
				return Promise.resolve([]);
			};
			const old = service.pushState();
			await service.pushState();
			assert.strictEqual(messages.length, 1);
			gate.resolve([]);
			await old;
			assert.strictEqual(messages.length, 1);
		});
	});

	it('检查权限/未知错误显示 unknown，不冒充文件缺失', async () => {
		for (const code of ['EACCES', 'EPERM', 'EIO']) {
			assert.strictEqual(await checkExecutableAvailability('test', async () => { throw Object.assign(new Error(code), { code }); }), 'unknown');
		}
		for (const code of ['ENOENT', 'ENOTDIR']) {
			assert.strictEqual(await checkExecutableAvailability('test', async () => { throw Object.assign(new Error(code), { code }); }), 'missing');
		}
		await fixture(async (service) => {
			assert.strictEqual((await service.buildSnapshot()).executable?.availability, 'unknown');
		}, async () => 'unknown');
	});

	it('选择对话框等待期间开始运行，返回结果不得切换正在运行的目标', async () => {
		await fixture(async (service, inner, exe, root) => {
			const original = vscode.window.showOpenDialog;
			const chosen = deferred<vscode.Uri[] | undefined>();
			vscode.window.showOpenDialog = () => chosen.promise;
			try {
				const picking = service.pickExecutable();
				inner._running = true;
				chosen.resolve([vscode.Uri.file(path.join(root, 'B.exe'))]);
				await picking;
				assert.strictEqual(inner._selectedExecutable.path, exe);
			} finally {
				vscode.window.showOpenDialog = original;
				inner._running = false;
			}
		});
	});

	it('选择新目标后立即检查，失效目标不会等到下个维护周期', async () => {
		await fixture(async (service, _inner, _exe, root) => {
			const messages = await attach(service);
			const original = vscode.window.showOpenDialog;
			const missing = path.join(root, 'missing.exe');
			vscode.window.showOpenDialog = async () => [vscode.Uri.file(missing)];
			try {
				await service.pickExecutable();
				assert.strictEqual(lastState(messages)?.executable?.path, vscode.Uri.file(missing).fsPath);
				assert.strictEqual(lastState(messages)?.executable?.availability, 'missing');
			} finally {
				vscode.window.showOpenDialog = original;
			}
		});
	});

	it('启动权限失败保留有效路径并显示原因，检查后删除则复检为失效', async () => {
		// 暂替换进程启动边界；RunService 的运行流程与错误恢复保持真实。
		const runner = require('../run/runner') as typeof import('../run/runner');
		const original = runner.runExecutable;
		try {
			await fixture(async (service, _inner, exe) => {
				const messages = await attach(service);
				runner.runExecutable = async () => { throw new Error('EACCES'); };
				await service.run('input');
				assert.strictEqual(lastState(messages)?.executable?.path, exe);
				assert.strictEqual(lastState(messages)?.executable?.availability, 'available');
				assert.match(lastState(messages)?.notice ?? '', /EACCES/);
				assert.strictEqual(lastState(messages)?.running, false);
				runner.runExecutable = async () => {
					await fs.unlink(exe);
					throw new Error('ENOENT');
				};
				await service.run('input');
				assert.strictEqual(lastState(messages)?.executable?.path, exe);
				assert.strictEqual(lastState(messages)?.executable?.availability, 'missing');
				assert.deepStrictEqual(lastState(messages)?.history, []);
			});
		} finally {
			runner.runExecutable = original;
		}
	});

});
