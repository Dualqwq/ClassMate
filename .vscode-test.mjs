import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
	label: 'unitTests',
	files: 'out/test/**/*.test.js',
	version: process.env.CLASSMATE_USE_MACHINE_PROFILE === '1' ? 'stable' : 'insiders',
	// 真实评测可以选择复用用户正常 VS Code 中已保存的模型配置和 SecretStorage。
	// 普通单元测试不设置该开关，仍使用隔离的 .vscode-test 用户目录。
	useInstallation: process.env.CLASSMATE_USE_MACHINE_PROFILE === '1'
		? { fromMachine: true }
		: process.env.CLASSMATE_TEST_VSCODE_PATH
			? { fromPath: process.env.CLASSMATE_TEST_VSCODE_PATH }
			: undefined,
	launchArgs: process.env.CLASSMATE_TEST_USER_DATA_DIR
		? [`--user-data-dir=${process.env.CLASSMATE_TEST_USER_DATA_DIR}`]
		: undefined,
	// @vscode/test-cli 不会自动把父进程中的自定义环境变量传给扩展宿主。
	// 这里只转发真实 API 测试需要的白名单字段；API Key 的值仍只存在于当前进程内存中。
	env: {
		CLASSMATE_LIVE_EVAL: process.env.CLASSMATE_LIVE_EVAL,
		CLASSMATE_LIVE_EVAL_API_KEY: process.env.CLASSMATE_LIVE_EVAL_API_KEY,
		CLASSMATE_LIVE_EVAL_PROVIDER: process.env.CLASSMATE_LIVE_EVAL_PROVIDER,
		CLASSMATE_LIVE_EVAL_MODEL: process.env.CLASSMATE_LIVE_EVAL_MODEL,
		CLASSMATE_LIVE_EVAL_API_URL: process.env.CLASSMATE_LIVE_EVAL_API_URL,
		CLASSMATE_EVAL_ROOT: process.env.CLASSMATE_EVAL_ROOT,
		CLASSMATE_EVAL_OUTPUT: process.env.CLASSMATE_EVAL_OUTPUT,
		CLASSMATE_EVAL_VERSION: process.env.CLASSMATE_EVAL_VERSION,
		CLASSMATE_LIVE_EVAL_LIMIT: process.env.CLASSMATE_LIVE_EVAL_LIMIT,
		CLASSMATE_LIVE_EVAL_IDS: process.env.CLASSMATE_LIVE_EVAL_IDS,
		CLASSMATE_LIVE_EVAL_RESUME: process.env.CLASSMATE_LIVE_EVAL_RESUME,
	},
	mocha: {
		ui: 'bdd',
		timeout: 20000,
	},
});
