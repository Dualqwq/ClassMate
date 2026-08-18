import * as assert from 'assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it } from 'mocha';
import { openBug1WorkspaceScenario } from '../eval/bug1WorkspaceScenario';

describe('bug1 workspace mutation scenario', () => {
	it('records exact evidence and restores the original workspace', async () => {
		const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'classmate-bug1-workspace-'));
		const filePath = path.join(workspacePath, 'monster.h');
		const original = 'void takeTurn() {\n    // TODO\n}\n';
		await fs.writeFile(filePath, original, 'utf8');

		const scenario = await openBug1WorkspaceScenario(workspacePath);
		try {
			const applied = await scenario.apply([{
				file: 'monster.h',
				replace: {
					from: '    // TODO',
					to: '    attack();',
				},
			}]);
			assert.strictEqual(applied.length, 1);
			assert.strictEqual(applied[0].beforeContent, original);
			assert.strictEqual(
				applied[0].afterContent,
				'void takeTurn() {\n    attack();\n}\n'
			);
			assert.match(applied[0].beforeHash, /^[a-f0-9]{64}$/);
			assert.match(applied[0].afterHash, /^[a-f0-9]{64}$/);
			assert.notStrictEqual(applied[0].beforeHash, applied[0].afterHash);
		} finally {
			await scenario.restore();
		}

		assert.strictEqual(await fs.readFile(filePath, 'utf8'), original);
	});

	it('rejects a mutation that escapes the workspace', async () => {
		const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'classmate-bug1-workspace-'));
		const scenario = await openBug1WorkspaceScenario(workspacePath);
		try {
			await assert.rejects(
				() => scenario.apply([{
					file: '../outside.cpp',
					replace: { from: 'a', to: 'b' },
				}]),
				/escapes the workspace/
			);
		} finally {
			await scenario.restore();
		}
	});
});
