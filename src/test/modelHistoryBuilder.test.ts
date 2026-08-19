import * as assert from 'assert';
import { describe, it } from 'mocha';
import {
	buildModelVisibleHistory,
	MODEL_HISTORY_TOKEN_BUDGET,
} from '../chat/modelHistoryBuilder';

const OLD_ANSWER = [
	'你现在打开的是 monster.h,takeTurn 还没写完。',
	'第一步,把下面两行取消注释:',
	'```cpp',
	'// std::cout << "===== turn =====" << std::endl;',
	'// player.takeDamage(attack_);',
	'```',
	'takeTurn 现在是空的,函数体只有注释。',
].join('\n');

const TEACHING_ANSWER = [
	'这题的核心是先理解 Creature 基类的伤害规则。',
	'你已经掌握了构造函数的写法,下一步看 takeDamage 的边界处理。',
	'记住:伤害先被格挡抵消,剩余部分才扣血。',
].join('\n');

function history(count: number, filler: string) {
	const result: Array<{ role: 'user' | 'assistant'; content: string }> = [];
	for (let index = 0; index < count; index++) {
		result.push({ role: 'user', content: `问题 ${index}: ${filler}` });
		result.push({
			role: 'assistant',
			content: index === 0 ? TEACHING_ANSWER : OLD_ANSWER,
		});
	}
	return result;
}

describe('model history builder', () => {
	it('keeps teaching progress while removing stale code blocks and state claims', () => {
		const visible = buildModelVisibleHistory({
			history: history(2, 'monster.h 怎么改'),
			currentFileHashes: new Map([['monster.h', 'hash-new']]),
			previousFileHashes: new Map([['monster.h', 'hash-old']]),
			tokenBudget: MODEL_HISTORY_TOKEN_BUDGET,
		});

		assert.strictEqual(visible.length, 4);
		// 旧代码块必须整体移除,不留半截 fence。
		for (const message of visible) {
			assert.ok(!message.content.includes('std::cout'), '旧代码正文不得进入模型历史');
			assert.ok(!message.content.includes('```cpp'), '旧代码块必须整体移除');
		}
		// 教学进度保留:最早一轮的纯教学回答完整在场。
		assert.ok(visible.some((message) =>
			message.content.includes('伤害先被格挡抵消')));
		// 与旧版本绑定的实现状态声明被替换为说明,不是删除整条消息。
		const stale = visible.find((message) =>
			message.role === 'assistant' && message.content.includes('此前讨论'));
		assert.ok(stale, '过期轮次应留下"此前讨论的是旧版本"的占位说明');
	});

	it('keeps history intact while file hashes are unchanged', () => {
		const source = history(2, '继续讲');
		const visible = buildModelVisibleHistory({
			history: source,
			currentFileHashes: new Map([['monster.h', 'hash-same']]),
			previousFileHashes: new Map([['monster.h', 'hash-same']]),
			tokenBudget: MODEL_HISTORY_TOKEN_BUDGET,
		});
		assert.deepStrictEqual(visible, source);
	});

	it('drops whole turns from the oldest side when the token budget is exceeded', () => {
		const big = history(12, 'x'.repeat(900));
		const visible = buildModelVisibleHistory({
			history: big,
			currentFileHashes: new Map(),
			previousFileHashes: new Map(),
			tokenBudget: 900,
		});
		assert.ok(visible.length < big.length, '超预算必须裁掉最旧的整轮');
		// 保留的部分必须以 user 开头(轮次边界完整,不产生悬空 assistant)。
		assert.strictEqual(visible[0].role, 'user');
		// 最新一轮必须保留。
		assert.strictEqual(
			visible[visible.length - 1].content,
			big[big.length - 1].content
		);
	});

	it('never drops the most recent turn even if it alone exceeds the budget', () => {
		const source: Array<{ role: 'user' | 'assistant'; content: string }> = [
			{ role: 'user', content: '很长的当前问题 '.repeat(500) },
			{ role: 'assistant', content: OLD_ANSWER },
		];
		const visible = buildModelVisibleHistory({
			history: source,
			currentFileHashes: new Map(),
			previousFileHashes: new Map(),
			tokenBudget: 100,
		});
		assert.strictEqual(visible.length, 2);
	});
});

describe('model history contract-notation hygiene (防模仿与多行块清洗)', () => {
	it('always strips finished links, source lines and refblock remnants, even when nothing changed', () => {
		const source = [
			{ role: 'user' as const, content: '怎么改?' },
			{
				role: 'assistant' as const,
				content: [
					'你现在需要补全 [`takeTurn`](classmate-ref://0) 函数。',
					'```cpp',
					'std::cout << "turn";',
					'```',
					'*来源: [`takeTurn`](classmate-ref://0) · monster.h:26–31*',
					'再看 [Creature](classmate-ref://3) 基类,以及补链 [`sort`](classmate-ref://1?i)。',
				].join('\n'),
			},
		];
		const visible = buildModelVisibleHistory({
			history: source,
			// hash 完全一致 → 旧逻辑不动这轮;防模仿清洗必须仍然执行。
			currentFileHashes: new Map([['monster.h', 'h1']]),
			previousFileHashes: new Map([['monster.h', 'h1']]),
			tokenBudget: MODEL_HISTORY_TOKEN_BUDGET,
		});
		const content = visible[1].content;
		assert.ok(!content.includes('classmate-ref://'), '成品链接必须剥掉,防模型模仿');
		assert.ok(!content.includes('*来源:'), '来源行必须剥掉');
		assert.ok(content.includes('`takeTurn`'), '行内代码文字保留');
		assert.ok(content.includes('Creature'), '普通文字保留');
		assert.ok(content.includes('```cpp'), '文件未变时代码块本体保留');
	});

	it('cleans multi-line blocks along with trailing source line when the file changed', () => {
		const source = [
			{ role: 'user' as const, content: '怎么改?' },
			{
				role: 'assistant' as const,
				content: [
					'改成这样:',
					'```cpp',
					'std::cout << "old";',
					'```',
					'*来源: [`takeTurn`](classmate-ref://0) · monster.h:26–31*',
					'takeTurn 现在是空的。',
				].join('\n'),
			},
		];
		const visible = buildModelVisibleHistory({
			history: source,
			currentFileHashes: new Map([['monster.h', 'h2']]),
			previousFileHashes: new Map([['monster.h', 'h1']]),
			tokenBudget: MODEL_HISTORY_TOKEN_BUDGET,
		});
		const content = visible[1].content;
		assert.ok(!content.includes('```'), '文件变化后多行代码块必须整体移除');
		assert.ok(!content.includes('classmate-ref://'), '链接与来源行一并清除');
		assert.ok(content.includes('旧版本'), '状态声明被替换为占位说明');
	});
});
