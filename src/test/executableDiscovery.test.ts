import * as assert from 'assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it } from 'mocha';
import {
	discoverExecutable,
	findNewestExecutable,
	findSourceFileForExecutable,
	hasRootMakefile,
	parseMakeLinkTarget,
	resolveGppExecutablePath,
} from '../run/executableDiscovery';

async function makeTempDir(): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), 'classmate-run-discovery-'));
}

describe('parseMakeLinkTarget (make 回显链接行解析)', () => {
	it('取最后一个 -o 目标(链接行在回显末尾)', () => {
		const output = [
			'g++ -std=c++17 -O2 -Wall -c main.cpp -o main.o',
			'g++ -std=c++17 -O2 -Wall -c battle.cpp -o battle.o',
			'g++ main.o battle.o -o card-battle.exe',
		].join('\r\n');
		assert.strictEqual(parseMakeLinkTarget(output), 'card-battle.exe');
	});

	it('支持带引号的目标路径', () => {
		const output = 'g++ main.o -o "my app.exe"';
		assert.strictEqual(parseMakeLinkTarget(output), 'my app.exe');
	});

	it('没有任何 -o 时返回 undefined', () => {
		assert.strictEqual(parseMakeLinkTarget('make: Nothing to be done.'), undefined);
	});

	it('忽略形如 -o -xxx 的无效目标', () => {
		assert.strictEqual(parseMakeLinkTarget('ld -o -plugin foo.o'), undefined);
	});
});

describe('resolveGppExecutablePath (与 compilerService.resolveOutputPath 同语义)', () => {
	it('按平台推导输出路径', () => {
		const source = process.platform === 'win32' ? 'C:\\ws\\main.cpp' : '/ws/main.cpp';
		const exe = resolveGppExecutablePath(source);
		if (process.platform === 'win32') {
			assert.strictEqual(exe, 'C:\\ws\\main.exe');
		} else {
			assert.strictEqual(exe, '/ws/main');
		}
	});
});

describe('findNewestExecutable (根目录最新 exe 兜底)', () => {
	it('只看根目录一层,取 mtime 最新的可执行文件', async () => {
		const dir = await makeTempDir();
		try {
			const ext = process.platform === 'win32' ? '.exe' : '';
			const older = path.join(dir, `old${ext}`);
			const newer = path.join(dir, `new${ext}`);
			await fs.writeFile(older, 'a');
			await fs.writeFile(newer, 'b');
			if (process.platform !== 'win32') {
				await fs.chmod(older, 0o755);
				await fs.chmod(newer, 0o755);
			}
			const past = new Date(Date.now() - 60_000);
			await fs.utimes(older, past, past);
			// 子目录里的 exe 不应被发现
			await fs.mkdir(path.join(dir, 'sub'));
			await fs.writeFile(path.join(dir, 'sub', `nested${ext}`), 'c');

			assert.strictEqual(await findNewestExecutable(dir), newer);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it('没有可执行文件时返回 undefined', async () => {
		const dir = await makeTempDir();
		try {
			await fs.writeFile(path.join(dir, 'main.cpp'), 'int main(){}');
			assert.strictEqual(await findNewestExecutable(dir), undefined);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});

describe('discoverExecutable (分级链)', () => {
	const exists = async () => true;
	const missing = async () => false;

	it('make 场景:回显 -o 命中优先(make-echo)', async () => {
		const dir = await makeTempDir();
		try {
			await fs.writeFile(path.join(dir, 'Makefile'), 'all:\n\tg++ main.cpp -o app.exe\n');
			const result = await discoverExecutable(
				dir,
				path.join(dir, 'main.cpp'),
				'g++ main.cpp -o app.exe',
				exists
			);
			assert.strictEqual(result.makeScenario, true);
			assert.strictEqual(result.source, 'make-echo');
			assert.strictEqual(result.exePath, path.join(dir, 'app.exe'));
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it('make 场景:回显没有 -o 时落到根目录最新 exe(latest-exe)', async () => {
		const dir = await makeTempDir();
		try {
			await fs.writeFile(path.join(dir, 'Makefile'), 'all:\n\t@echo hi\n');
			const exeName = process.platform === 'win32' ? 'app.exe' : 'app';
			const exePath = path.join(dir, exeName);
			await fs.writeFile(exePath, 'bin');
			if (process.platform !== 'win32') {
				await fs.chmod(exePath, 0o755);
			}
			const result = await discoverExecutable(dir, undefined, 'make: Nothing to be done.', missing);
			assert.strictEqual(result.source, 'latest-exe');
			assert.strictEqual(result.exePath, exePath);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it('make 场景:回显的 -o 目标不存在时不当作命中', async () => {
		const dir = await makeTempDir();
		try {
			await fs.writeFile(path.join(dir, 'Makefile'), 'all:\n\tg++ main.cpp -o app.exe\n');
			const result = await discoverExecutable(dir, undefined, 'g++ main.cpp -o app.exe', missing);
			assert.strictEqual(result.exePath, undefined);
			assert.ok(result.notice);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it('g++ 场景:由 active 源文件推导(source-derived)', async () => {
		const dir = await makeTempDir();
		try {
			const source = path.join(dir, 'main.cpp');
			await fs.writeFile(source, 'int main(){}');
			const result = await discoverExecutable(dir, source, undefined, exists);
			assert.strictEqual(result.makeScenario, false);
			assert.strictEqual(result.source, 'source-derived');
			assert.strictEqual(result.exePath, resolveGppExecutablePath(source));
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it('g++ 场景:推导产物不存在 → 提示先编译', async () => {
		const dir = await makeTempDir();
		try {
			const source = path.join(dir, 'main.cpp');
			const result = await discoverExecutable(dir, source, undefined, missing);
			assert.strictEqual(result.exePath, undefined);
			assert.match(result.notice ?? '', /先编译/);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});

describe('hasRootMakefile', () => {
	it('识别 Makefile / makefile / GNUmakefile,不递归', async () => {
		const dir = await makeTempDir();
		try {
			assert.strictEqual(await hasRootMakefile(dir), false);
			await fs.writeFile(path.join(dir, 'GNUmakefile'), 'all:');
			assert.strictEqual(await hasRootMakefile(dir), true);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});

describe('findSourceFileForExecutable (exe → 源文件归位)', () => {
	it('同目录同 stem 的 .cpp 命中(真实临时目录)', async () => {
		const dir = await makeTempDir();
		try {
			const source = path.join(dir, 'main.cpp');
			await fs.writeFile(source, 'int main(){}');
			const exe = process.platform === 'win32' ? path.join(dir, 'main.exe') : path.join(dir, 'main');
			assert.strictEqual(await findSourceFileForExecutable(exe), source);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it('注入 fileExists:按 .cpp → .cc → .cxx → .c++ → .c 顺序尝试', async () => {
		const dir = path.join('ws', 'bin');
		const seen: string[] = [];
		const result = await findSourceFileForExecutable(path.join(dir, 'main.exe'), async (candidate) => {
			seen.push(candidate);
			return candidate.endsWith('.c');
		});
		assert.strictEqual(result, path.join(dir, 'main.c'));
		assert.deepStrictEqual(seen, [
			path.join(dir, 'main.cpp'),
			path.join(dir, 'main.cc'),
			path.join(dir, 'main.cxx'),
			path.join(dir, 'main.c++'),
			path.join(dir, 'main.c'),
		]);
	});

	it('同目录没有同 stem 源文件时返回 undefined(消费方回退 exe 路径)', async () => {
		const dir = path.join('ws', 'bin');
		const result = await findSourceFileForExecutable(path.join(dir, 'main.exe'), async () => false);
		assert.strictEqual(result, undefined);
	});
});
