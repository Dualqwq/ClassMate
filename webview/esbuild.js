const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');

const buildOptions = {
	entryPoints: ['./webview/src/index.tsx'],
	bundle: true,
	outfile: './dist/webview.js',
	format: 'iife',
	target: 'es2020',
	platform: 'browser',
	sourcemap: true,
	minify: process.env.NODE_ENV === 'production',
	define: {
		'process.env.NODE_ENV': process.env.NODE_ENV === 'production' ? '"production"' : '"development"',
	},
	loader: {
		'.tsx': 'tsx',
		'.ts': 'ts',
	},
};

async function main() {
	try {
		if (watch) {
			const ctx = await esbuild.context(buildOptions);
			await ctx.watch();
			console.log('Watching webview sources for changes...');
		} else {
			await esbuild.build(buildOptions);
			console.log('Webview bundle built: dist/webview.js');
		}
	} catch (err) {
		console.error('Webview build failed:', err);
		process.exit(1);
	}
}

void main();
