import * as assert from 'assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it } from 'mocha';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
// import * as myExtension from '../../extension';

describe('Extension Test Suite', () => {
	it('Sample test', () => {
		void vscode.window.showInformationMessage('Start all tests.');
		assert.strictEqual(-1, [1, 2, 3].indexOf(5));
		assert.strictEqual(-1, [1, 2, 3].indexOf(0));
	});

	it('exports real extension conversation diagnostics through a command', async () => {
		const extension = vscode.extensions.getExtension('undefined_publisher.classmate');
		assert.ok(extension);
		await extension.activate();
		const commands = await vscode.commands.getCommands(true);
		assert.ok(commands.includes('classmate.exportConversationDiagnostics'));
		assert.ok(commands.includes('classmate.openLocalSettings'));
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'classmate-command-export-'));
		const outputPath = path.join(directory, 'diagnostics.json');

		await vscode.commands.executeCommand(
			'classmate.exportConversationDiagnostics',
			outputPath,
			{ reveal: false }
		);

		const bundle = JSON.parse(await fs.readFile(outputPath, 'utf8')) as {
			schemaVersion: number;
			conversations: unknown[];
			events: unknown[];
		};
		assert.strictEqual(bundle.schemaVersion, 1);
		assert.ok(Array.isArray(bundle.conversations));
		assert.ok(Array.isArray(bundle.events));
		assert.ok(!(await fs.readFile(outputPath, 'utf8')).includes('classmate.apiKey'));
	});
});
