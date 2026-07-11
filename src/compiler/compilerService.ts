import { spawn, spawnSync } from 'child_process';
import * as path from 'path';

export interface CompileResult {
    exitCode: number | null;
    stdout: string;
    stderr: string;
    durationMs: number;
    outputPath: string;
}

export interface RunResult {
    exitCode: number | null;
    stdout: string;
    stderr: string;
    durationMs: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Build the environment object that forces English compiler diagnostics.
 */
function buildEnglishEnv(): NodeJS.ProcessEnv {
    return {
        ...process.env,
        LANG: 'C',
        LC_ALL: 'C',
    };
}

/**
 * Determine the executable output path based on the source file name.
 * On Windows this is <source>.exe; on Unix-like systems it is just <source>
 * with the extension stripped.
 */
function resolveOutputPath(sourcePath: string): string {
    const parsed = path.parse(sourcePath);
    if (process.platform === 'win32') {
        return path.join(parsed.dir, `${parsed.name}.exe`);
    }
    return path.join(parsed.dir, parsed.name);
}

/**
 * Check whether g++ is available on the system PATH.
 */
/**
 * Check whether g++ is available on the system PATH.
 *
 * On Windows we spawn through the default shell so that PATH entries with
 * spaces and .exe/.cmd wrappers are resolved the same way a user terminal
 * would resolve them. On Unix-like systems we spawn directly.
 */
/**
 * Try to run a command and return whether it exits successfully.
 */
function tryCommand(command: string, args: string[], options?: { shell?: boolean }): boolean {
    try {
        const result = spawnSync(command, args, {
            env: buildEnglishEnv(),
            shell: options?.shell ?? false,
            windowsHide: true,
        });
        return result.status === 0;
    } catch {
        return false;
    }
}

/**
 * Check whether g++ is available on the system PATH.
 *
 * On Windows, spawning through the shell handles PATH entries with spaces and
 * .cmd/.bat wrappers. We also try g++.exe directly in case shell resolution is
 * unavailable or behaves differently across VS Code launch environments.
 */
export function checkGppAvailability(): boolean {
    const candidates: { command: string; args: string[]; shell?: boolean }[] = [
        { command: 'g++', args: ['--version'] },
    ];

    if (process.platform === 'win32') {
        candidates.push(
            { command: 'g++.exe', args: ['--version'] },
            { command: 'g++', args: ['--version'], shell: true },
            { command: 'g++.exe', args: ['--version'], shell: true },
            { command: 'where', args: ['g++'], shell: true }
        );
    }

    return candidates.some((candidate) => tryCommand(candidate.command, candidate.args, { shell: candidate.shell }));
}

/**
 * Spawn g++ to compile a single source file.
 *
 * The output executable is named after the source file (e.g. hello.cpp -> hello.exe)
 * and placed in the same directory. Stderr is forced to English so downstream
 * regex parsing is stable.
 */
export async function spawnGpp(
    sourcePath: string,
    options?: { timeout?: number; signal?: AbortSignal }
): Promise<CompileResult> {
    const outputPath = resolveOutputPath(sourcePath);
    const args = ['-std=c++17', '-O2', '-Wall', '-o', outputPath, sourcePath];
    const timeout = options?.timeout ?? DEFAULT_TIMEOUT_MS;

    const result = await spawnProcess('g++', args, { timeout, signal: options?.signal });
    return { ...result, outputPath };
}

/**
 * Run the compiled executable for a single source file.
 */
export async function spawnExecutable(
    executablePath: string,
    options?: { timeout?: number; signal?: AbortSignal }
): Promise<RunResult> {
    const timeout = options?.timeout ?? DEFAULT_TIMEOUT_MS;

    // On Windows, executablePath ends with .exe and can be spawned directly.
    // On Unix-like systems, the path is also absolute and executable.
    return spawnProcess(executablePath, [], { timeout, signal: options?.signal });
}

interface SpawnProcessOptions {
    timeout?: number;
    signal?: AbortSignal;
}

/**
 * Shared process spawner for g++ and the compiled executable.
 *
 * On Windows we first try to spawn directly. If that fails (common when g++
 * is a .cmd wrapper or PATH entry contains spaces that direct resolution does
 * not handle), we fall back to shell mode.
 */
function spawnProcess(
    command: string,
    args: string[],
    options: SpawnProcessOptions = {},
    triedShell = false
): Promise<{ exitCode: number | null; stdout: string; stderr: string; durationMs: number }> {
    const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;

    return new Promise((resolve, reject) => {
        const start = Date.now();
        let stdout = '';
        let stderr = '';

        const child = spawn(command, args, {
            env: buildEnglishEnv(),
            shell: triedShell && process.platform === 'win32',
            windowsHide: true,
        });

        const timeoutHandle = setTimeout(() => {
            child.kill('SIGTERM');
            reject(new Error(`Command "${command}" timed out after ${timeout}ms`));
        }, timeout);

        child.stdout?.on('data', (data: Buffer) => {
            stdout += data.toString('utf-8');
        });

        child.stderr?.on('data', (data: Buffer) => {
            stderr += data.toString('utf-8');
        });

        child.on('error', async (error) => {
            clearTimeout(timeoutHandle);
            if (process.platform === 'win32' && !triedShell) {
                try {
                    const result = await spawnProcess(command, args, options, true);
                    resolve(result);
                } catch (shellError) {
                    reject(shellError);
                }
            } else {
                reject(error);
            }
        });

        child.on('close', (exitCode) => {
            clearTimeout(timeoutHandle);
            resolve({
                exitCode,
                stdout,
                stderr,
                durationMs: Date.now() - start,
            });
        });

        options.signal?.addEventListener('abort', () => {
            child.kill('SIGTERM');
            reject(new Error(`Command "${command}" was cancelled.`));
        });
    });
}
