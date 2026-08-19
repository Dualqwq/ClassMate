import * as assert from 'assert';
import { describe, it } from 'mocha';
import { detectCodeBlockSources } from '../chat/answerBlockSourceDetector';
import type { CppSymbol } from '../parser/cppWorkspaceIndex';

const MONSTER_H = [
	'#pragma once',
	'class Monster : public Creature',
	'{',
	'public:',
	'    void takeTurn(Player &player)',
	'    {',
	'        std::cout << "===== " << name_ << " turn =====" << std::endl;',
	'        player.takeDamage(attack_);',
	'    }',
	'    void printStatus()',
	'    {',
	'        std::cout << name_ << " HP";',
	'    }',
	'};',
].join('\n');

const CREATURE_H = [
	'#pragma once',
	'class Creature',
	'{',
	'public:',
	'    void takeDamage(int damage)',
	'    {',
	'        health_ -= damage;',
	'    }',
	'};',
].join('\n');

const SYMBOLS: CppSymbol[] = [
	{
		targetId: 'sym:monster.h:Monster:takeTurn',
		file: 'monster.h',
		name: 'takeTurn',
		kind: 'method',
		container: 'Monster',
		startLine: 5,
		endLine: 9,
	},
	{
		targetId: 'sym:monster.h:Monster:printStatus',
		file: 'monster.h',
		name: 'printStatus',
		kind: 'method',
		container: 'Monster',
		startLine: 10,
		endLine: 13,
	},
	{
		targetId: 'sym:creature.h:Creature:takeDamage',
		file: 'creature.h',
		name: 'takeDamage',
		kind: 'method',
		container: 'Creature',
		startLine: 5,
		endLine: 8,
	},
];

function files(): Map<string, string> {
	return new Map([
		['monster.h', MONSTER_H],
		['creature.h', CREATURE_H],
	]);
}

describe('detectCodeBlockSources (程序侧块来源自查)', () => {
	it('attributes a quoted function body to its unique symbol', () => {
		const answer = [
			'改成这样:',
			'',
			'```cpp',
			'void takeTurn(Player &player)',
			'{',
			'    player.takeDamage(attack_);',
			'}',
			'```',
		].join('\n');
		const sources = detectCodeBlockSources(answer, SYMBOLS, files());
		assert.strictEqual(sources.length, 1);
		assert.strictEqual(sources[0].blockIndex, 0);
		// 行序一致(签名行连续子序列)即可命中,花括号风格差异不影响。
		assert.strictEqual(sources[0].status, 'unique');
		assert.strictEqual(sources[0].file, 'monster.h');
		assert.strictEqual(sources[0].targetId, 'sym:monster.h:Monster:takeTurn');
	});

	it('attributes block-level code with no covering symbol to the file only', () => {
		const answer = [
			'```cpp',
			'#pragma once',
			'class Creature',
			'{',
			'```',
		].join('\n');
		const sources = detectCodeBlockSources(answer, SYMBOLS, files());
		assert.strictEqual(sources[0].status, 'unique-file');
		assert.strictEqual(sources[0].file, 'creature.h');
		assert.strictEqual(sources[0].targetId, undefined);
	});

	it('marks blocks appearing in multiple files as ambiguous (宁缺毋滥)', () => {
		// health_ -= damage; 只在 creature.h,构造一个双文件冲突:
		const dupFiles = new Map([
			['a.cpp', 'int run() {\n    doWork();\n}\n'],
			['b.cpp', 'int run() {\n    doWork();\n}\n'],
		]);
		const dupSymbols: CppSymbol[] = [
			{ targetId: 'sym:a.cpp::run', file: 'a.cpp', name: 'run', kind: 'function', startLine: 1, endLine: 3 },
			{ targetId: 'sym:b.cpp::run', file: 'b.cpp', name: 'run', kind: 'function', startLine: 1, endLine: 3 },
		];
		const answer = '```cpp\ndoWork();\n```';
		const sources = detectCodeBlockSources(answer, dupSymbols, dupFiles);
		assert.strictEqual(sources[0].status, 'ambiguous');
		assert.strictEqual(sources[0].file, undefined);
	});

	it('reports none for freshly written example code absent from the workspace', () => {
		const answer = '```cpp\nint brandNewExample = 42;\nstd::sort(v.begin(), v.end());\n```';
		const sources = detectCodeBlockSources(answer, SYMBOLS, files());
		assert.strictEqual(sources[0].status, 'none');
	});

	it('ignores pure-noise lines (braces/semicolons) when building the signature', () => {
		const answer = ['```cpp', '{', '}', ';', '```'].join('\n');
		const sources = detectCodeBlockSources(answer, SYMBOLS, files());
		assert.strictEqual(sources[0].status, 'none', '无有效签名行按 none 处理');
	});

	it('handles multiple blocks independently', () => {
		const answer = [
			'```cpp',
			'player.takeDamage(attack_);',
			'```',
			'文字',
			'```cpp',
			'health_ -= damage;',
			'```',
		].join('\n');
		const sources = detectCodeBlockSources(answer, SYMBOLS, files());
		assert.strictEqual(sources.length, 2);
		assert.strictEqual(sources[0].file, 'monster.h');
		assert.strictEqual(sources[1].file, 'creature.h');
	});
});
