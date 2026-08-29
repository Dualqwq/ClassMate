'use strict';
/**
 * 测试基建修复:保证扩展宿主测试进程里只存在一份 mocha 模块实例。
 *
 * 背景(2026-08-29 排查,详见分支 feat/composer-paste-collapse 报告):
 * @vscode/test-cli 的 runner.cjs 刻意把 mocha、测试文件路径的盘符小写化
 * (见其源码 normalizeCasing 注释:"Normalize to lower-case drive letter to
 * avoid path sensitivity in the loader duplicating imports"),因此 runner
 * 顶部 require("mocha") 落在小写 c: 的 require cache 键上。
 * 而测试文件从 agent worktree(根 node_modules 是指向主 checkout 的
 * junction)解析 'mocha' 时,node 对 junction 做 realpath 会把盘符规范化成
 * 大写 C:,得到另一组 cache 键 → 同一进程出现两份 mocha 实例。
 * 测试文件 `import { describe, it } from 'mocha'` 拿到的副本从未被 runner
 * 执行过 ui('bdd')(currentContext 只在 runner 那份里被赋值),于是第一个
 * 被 glob 加载的测试文件即抛
 * "TypeError: Cannot read properties of undefined (reading 'describe')"。
 * 主 checkout(node_modules 是真实目录、无 junction)不受影响。
 *
 * 修复方式:本文件经 .vscode-test.mjs 的 mocha.require 选项、在测试文件
 * 加载之前被 runner require(见 runner.cjs:required = [...preload,
 * ...mochaOpts.require])。这里检测两种盘符大小写形态中哪一份已在
 * require cache(即 runner 加载的那份),把它的全部 cache 条目镜像到另一
 * 种大小写键上——之后测试文件 require('mocha') 命中镜像键,拿到的就是
 * runner 的同一实例。双向检测:无论 runner 落在哪种大小写形态都成立。
 */

const path = require('path');

function flipDriveLetter(p) {
	if (/^[A-Za-z]:/.test(p)) {
		const head = p[0] === p[0].toUpperCase() ? p[0].toLowerCase() : p[0].toUpperCase();
		return head + p.slice(1);
	}
	return p;
}

const resolvedMain = require.resolve('mocha');
const variants = [resolvedMain, flipDriveLetter(resolvedMain)];
const presentMain = variants.find((p) => require.cache[p] !== undefined);
if (presentMain === undefined) {
	// 两份都不在 cache:runner 尚未加载 mocha(异常形态)。此时测试文件将
	// 自己加载并成为唯一实例,无需镜像,直接退出。
	module.exports = {};
	return;
}
const absentMain = variants.find((p) => p !== presentMain);
const presentRoot = path.dirname(presentMain);
const absentRoot = flipDriveLetter(presentRoot);

let mirrored = 0;
for (const key of Object.keys(require.cache)) {
	if (!key.startsWith(presentRoot + path.sep) && key !== presentMain) {
		continue;
	}
	const rel = key === presentMain ? path.sep + path.basename(key) : key.slice(presentRoot.length);
	const aliasKey = absentRoot + rel;
	if (require.cache[aliasKey] === undefined) {
		require.cache[aliasKey] = require.cache[key];
		mirrored += 1;
	}
}

if (process.env.CLASSMATE_MOCHA_ALIAS_DEBUG === '1') {
	console.log(
		`[test-mocha-singleton-alias] present=${presentMain} mirrored=${mirrored} module(s) to ${absentRoot}`
	);
}

module.exports = {};
