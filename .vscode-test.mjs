import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
	label: 'unitTests',
	files: 'out/test/**/*.test.js',
	version: 'insiders',
	mocha: {
		ui: 'bdd',
		timeout: 20000,
	},
});
