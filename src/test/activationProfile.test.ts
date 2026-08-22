import * as assert from 'assert';
import { promises as fs } from 'fs';
import * as path from 'path';
import { performance } from 'perf_hooks';
import { describe, it } from 'mocha';
import * as vscode from 'vscode';
import type { ClassMateDevelopmentApi } from '../extension';

const BENCHMARK_DIR = path.resolve(__dirname, '..', '..', 'benchmark');

interface BenchmarkReport {
	date: string;
	mode: string;
	extensionVersion: string;
	externalTotalMs: number;
	profileTotalMs: number;
	phases: { name: string; ms: number }[];
}

describe('Activation profile benchmark', () => {
	it('captures a reproducible activation baseline', async function () {
		this.timeout(60000);

		const extension = vscode.extensions.getExtension<ClassMateDevelopmentApi>(
			'undefined_publisher.classmate'
		);
		assert.ok(extension, 'ClassMate extension should be registered');

		let externalTotalMs = 0;
		if (!extension.isActive) {
			const start = performance.now();
			await extension.activate();
			externalTotalMs = Number((performance.now() - start).toFixed(3));
		}

		const api = extension.exports;
		assert.ok(api, 'dev API should be exported in test build');
		assert.ok(typeof api.getActivationProfile === 'function');

		const profile = api.getActivationProfile();
		assert.ok(profile, 'activation profile should be captured');
		assert.ok(profile.totalMs > 0, 'total activation time should be positive');
		assert.ok(profile.phases.length > 0, 'phase breakdown should be present');

		// Sanity ceiling: the activate() body is ~5 ms; the whole bundle load+execute
		// is ~80 ms in prod on reference hardware. We leave a generous margin so this
		// test never flakes on slower CI runners, while still catching pathological
		// regressions (e.g. accidental synchronous file I/O inside activate).
		assert.ok(
			profile.totalMs < 10000,
			`activate() profile total ${profile.totalMs}ms is unreasonably high`
		);

		const report: BenchmarkReport = {
			date: new Date().toISOString(),
			mode: typeof api.getActivationProfile === 'function' ? 'development/test' : 'production',
			extensionVersion: extension.packageJSON.version ?? 'unknown',
			externalTotalMs,
			profileTotalMs: profile.totalMs,
			phases: profile.phases,
		};

		await fs.mkdir(BENCHMARK_DIR, { recursive: true });
		await fs.writeFile(
			path.join(BENCHMARK_DIR, 'activation-baseline-latest.json'),
			JSON.stringify(report, null, 2),
			'utf8'
		);

		const markdown = [
			'# ClassMate Activation Baseline (latest run)',
			'',
			`- Date: ${report.date}`,
			`- Mode: ${report.mode}`,
			`- Extension version: ${report.extensionVersion}`,
			`- External activate() wall time: ${report.externalTotalMs} ms`,
			`- Profiled activate() body total: ${report.profileTotalMs} ms`,
			'',
			'## Phase breakdown',
			'',
			'| Phase | ms |',
			'|---|---|',
			...report.phases.map((p) => `| ${p.name} | ${p.ms} |`),
			'',
		].join('\n');
		await fs.writeFile(
			path.join(BENCHMARK_DIR, 'activation-baseline-latest.md'),
			markdown,
			'utf8'
		);

		console.log('[activation-profile]', JSON.stringify(report));
	});
});
