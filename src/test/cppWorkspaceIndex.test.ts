import * as assert from 'assert';
import { describe, it } from 'mocha';
import {
	buildCppWorkspaceIndex,
} from '../parser/cppWorkspaceIndex';

const MONSTER_H = `#pragma once

#define MAX_ATTACK 99

#include <string>

class Monster : public Creature
{
private:
    int attack_;

public:
    Monster(std::string n, int h, int a)
        : Creature(n, h), attack_(a)
    {
    }

    ~Monster()
    {
    }

    bool operator==(const Monster &other) const
    {
        return attack_ == other.attack_;
    }

    int getAttack() const
    {
        return attack_;
    }

    void takeTurn(Player &player)
    {
        std::cout << name_ << " attacks " << std::endl;
        player.takeDamage(attack_);
    }

    void emptyBody()
    {
    }

    void commentOnlyBody()
    {
        // TODO: 输出状态
    }
};

void helper(int value)
{
    return;
}
`;

describe('cpp workspace index', () => {
	it('extracts classes, members, functions and macros with kinds and ranges', async () => {
		const index = await buildCppWorkspaceIndex([
			{ path: 'monster.h', content: MONSTER_H },
		]);

		assert.strictEqual(index.degradedFiles.length, 0);
		// 同名符号(类 Monster 与构造函数 Monster)各自存在;用 find 而不是
		// name→kind 映射,避免后者覆盖前者。
		const monsterClass = index.symbols.find(
			(symbol) => symbol.name === 'Monster' && symbol.kind === 'class'
		);
		assert.ok(monsterClass);
		assert.ok(index.symbols.some((symbol) => symbol.name === 'MAX_ATTACK' && symbol.kind === 'macro'));
		assert.ok(index.symbols.some((symbol) => symbol.name === 'attack_' && symbol.kind === 'field'));
		// 构造/析构/运算符必须可区分,不能都塞进普通函数。
		const monster = index.symbols.filter((symbol) => symbol.container === 'Monster');
		assert.ok(monster.some((symbol) => symbol.kind === 'constructor'));
		assert.ok(monster.some((symbol) => symbol.kind === 'destructor'));
		assert.ok(monster.some((symbol) => symbol.kind === 'operator' && symbol.name === 'operator=='));
		assert.ok(monster.some((symbol) => symbol.kind === 'method' && symbol.name === 'takeTurn'));
		const helper = index.symbols.find((symbol) => symbol.name === 'helper');
		assert.ok(helper);
		assert.strictEqual(helper.kind, 'function');
		assert.strictEqual(helper.container, undefined);
		// 行号是 1-based 定义范围。
		assert.ok(helper.startLine > 0 && helper.endLine >= helper.startLine);
	});

	it('reports body facts for count and existence claims', async () => {
		const index = await buildCppWorkspaceIndex([
			{ path: 'monster.h', content: MONSTER_H },
		]);
		const byName = (container: string | undefined, name: string) =>
			index.symbols.find((symbol) => symbol.container === container && symbol.name === name);

		const takeTurn = byName('Monster', 'takeTurn');
		assert.ok(takeTurn?.body);
		assert.strictEqual(takeTurn.body.empty, false);
		assert.strictEqual(takeTurn.body.commentOnly, false);
		assert.strictEqual(takeTurn.body.nonEmptyStatementCount, 2);
		// 调用名单覆盖成员调用与 cout 流写入,供"是否调用了 X"核对。
		assert.ok(takeTurn.body.calledNames.includes('takeDamage'));

		const emptyBody = byName('Monster', 'emptyBody');
		assert.ok(emptyBody?.body);
		assert.strictEqual(emptyBody.body.empty, true);
		assert.strictEqual(emptyBody.body.commentOnly, false);
		assert.strictEqual(emptyBody.body.nonEmptyStatementCount, 0);

		const commentOnly = byName('Monster', 'commentOnlyBody');
		assert.ok(commentOnly?.body);
		assert.strictEqual(commentOnly.body.empty, true);
		assert.strictEqual(commentOnly.body.commentOnly, true);
		assert.strictEqual(commentOnly.body.nonEmptyStatementCount, 0);
	});

	it('keeps target ids stable across rebuilds and unrelated edits', async () => {
		const first = await buildCppWorkspaceIndex([
			{ path: 'monster.h', content: MONSTER_H },
		]);
		const second = await buildCppWorkspaceIndex([
			{ path: 'monster.h', content: MONSTER_H },
		]);
		assert.deepStrictEqual(
			second.symbols.map((symbol) => symbol.targetId),
			first.symbols.map((symbol) => symbol.targetId)
		);

		// 修改另一个函数的实现不应改变 takeTurn 的 targetId。
		const edited = MONSTER_H.replace(
			/void helper\(int value\)\n\{[\s\S]*?\n\}/,
			'void helper(int value)\n{\n    value = value + 1;\n    return;\n}'
		);
		const third = await buildCppWorkspaceIndex([
			{ path: 'monster.h', content: edited },
		]);
		const idOf = (index: typeof first) => index.symbols
			.find((symbol) => symbol.container === 'Monster' && symbol.name === 'takeTurn')?.targetId;
		assert.strictEqual(idOf(third), idOf(first));
		// 但 helper 的体事实应当反映新内容。
		const helper = third.symbols.find((symbol) => symbol.name === 'helper');
		assert.strictEqual(helper?.body?.nonEmptyStatementCount, 2);
	});

	it('counts commented-out lines as comments, not statements (bug1 core scenario)', async () => {
		const content = [
			'void takeTurn(Player &player)',
			'{',
			'    // std::cout << "===== turn =====" << std::endl;',
			'    // std::cout << " attacks " << std::endl;',
			'    // player.takeDamage(attack_);',
			'}',
			'',
		].join('\n');
		const index = await buildCppWorkspaceIndex([{ path: 'monster.h', content }]);
		const takeTurn = index.symbols.find((symbol) => symbol.name === 'takeTurn');
		assert.ok(takeTurn?.body);
		assert.strictEqual(takeTurn.body.empty, true);
		assert.strictEqual(takeTurn.body.commentOnly, true);
		assert.strictEqual(takeTurn.body.nonEmptyStatementCount, 0);
		assert.deepStrictEqual(takeTurn.body.calledNames, []);
	});

	it('degrades per file without inventing symbols', async () => {
		const index = await buildCppWorkspaceIndex([
			{ path: 'broken.cpp', content: '\u0000\u0001\u0002 not utf8-parseable \ufffd' },
			{ path: 'fine.cpp', content: 'int add(int a, int b)\n{\n    return a + b;\n}\n' },
		]);

		assert.ok(index.degradedFiles.some((entry) => entry.file === 'broken.cpp'));
		const fine = index.symbols.find((symbol) => symbol.name === 'add' && symbol.file === 'fine.cpp');
		assert.ok(fine, '其他文件不受坏文件影响');
		// 坏文件不得伪造任何符号。
		assert.ok(index.symbols.every((symbol) => symbol.file !== 'broken.cpp'));
	});
});
