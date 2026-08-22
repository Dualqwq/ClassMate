import { performance } from 'perf_hooks';
import * as vscode from 'vscode';

export interface ActivationPhase {
	name: string;
	ms: number;
}

export interface ActivationProfile {
	totalMs: number;
	phases: ActivationPhase[];
}

let lastProfile: ActivationProfile | undefined;

/**
 * Returns the profile captured during the most recent extension activation.
 * Undefined before the first activation finishes.
 */
export function getActivationProfile(): ActivationProfile | undefined {
	return lastProfile;
}

/**
 * Low-intrusive activation timer. Enabled in development/test builds so we can
 * reproduce baseline numbers; disabled in production to avoid polluting user
 * logs or adding overhead to the activation path.
 */
export class ActivationProfiler {
	private readonly start: number;
	private readonly marks: { name: string; time: number }[] = [];
	private finished = false;

	constructor(
		private readonly enabled: boolean,
		private readonly outputChannel?: vscode.OutputChannel
	) {
		this.start = performance.now();
		if (enabled) {
			this.marks.push({ name: 'start', time: this.start });
		}
	}

	mark(name: string): void {
		if (!this.enabled || this.finished) {
			return;
		}
		this.marks.push({ name, time: performance.now() });
	}

	finish(): ActivationProfile | undefined {
		if (!this.enabled || this.finished) {
			return undefined;
		}
		this.finished = true;
		const end = performance.now();
		const phases: ActivationPhase[] = [];
		for (let i = 1; i < this.marks.length; i++) {
			phases.push({
				name: this.marks[i].name,
				ms: Number((this.marks[i].time - this.marks[i - 1].time).toFixed(3)),
			});
		}
		const totalMs = Number((end - this.start).toFixed(3));
		const profile: ActivationProfile = { totalMs, phases };
		lastProfile = profile;
		this.outputChannel?.appendLine(`[activation] total=${totalMs}ms`);
		for (const phase of phases) {
			this.outputChannel?.appendLine(`[activation] ${phase.name}=${phase.ms}ms`);
		}
		return profile;
	}
}

/**
 * Whether activation profiling should run in this extension host.
 * Production builds are always opted out so we never write timing noise to a
 * user's ClassMate Performance output channel.
 */
export function isActivationProfilingEnabled(context: vscode.ExtensionContext): boolean {
	if (context.extensionMode === vscode.ExtensionMode.Production) {
		return false;
	}
	return vscode.workspace.getConfiguration('classmate').get<boolean>('activationProfiling', true);
}
