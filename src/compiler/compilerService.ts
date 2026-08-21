import { spawn, spawnSync } from 'child_process';
import * as path from 'path';
import { readdir } from 'fs/promises';

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

export type MakeTool = 'make' | 'mingw32-make';

/**
 * Probe for a make executable: try `make` first, then `mingw32-make`.
 *
 * Reuses the Windows shell-fallback strategy from checkGppAvailability.
 * The command runner is injectable so the fallback order is unit-testable
 * without a real make installation.
 */
export function detectMakeTool(
    run: (command: string, args: string[], options?: { shell?: boolean }) => boolean = tryCommand
): MakeTool | undefined {
    for (const tool of ['make', 'mingw32-make'] as const) {
        const candidates: { command: string; args: string[]; shell?: boolean }[] = [
            { command: tool, args: ['--version'] },
        ];

        if (process.platform === 'win32') {
            candidates.push(
                { command: `${tool}.exe`, args: ['--version'] },
                { command: tool, args: ['--version'], shell: true }
            );
        }

        if (candidates.some((candidate) => run(candidate.command, candidate.args, { shell: candidate.shell }))) {
            return tool;
        }
    }

    return undefined;
}

const MAKEFILE_NAMES = new Set(['makefile', 'gnumakefile']);

/**
 * Find a Makefile placed directly at the workspace root (case-insensitive).
 * Subdirectories are never searched — ClassMate only honors a root Makefile.
 */
export async function findRootMakefile(workspaceRoot: string): Promise<string | undefined> {
    let entries;
    try {
        entries = await readdir(workspaceRoot, { withFileTypes: true });
    } catch {
        return undefined;
    }

    const hit = entries.find((entry) => entry.isFile() && MAKEFILE_NAMES.has(entry.name.toLowerCase()));
    return hit ? path.join(workspaceRoot, hit.name) : undefined;
}

export interface MakeBuildResult {
    exitCode: number | null;
    stdout: string;
    stderr: string;
    durationMs: number;
    tool: MakeTool;
    cwd: string;
}

/**
 * Run make with no arguments (default target) in the workspace root.
 * Which sources get built is entirely decided by the Makefile.
 */
export async function spawnMake(
    tool: MakeTool,
    cwd: string,
    options?: { timeout?: number; signal?: AbortSignal }
): Promise<MakeBuildResult> {
    const timeout = options?.timeout ?? DEFAULT_TIMEOUT_MS;
    const result = await spawnProcess(tool, [], { timeout, signal: options?.signal, cwd });
    return { ...result, tool, cwd };
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
    const sourcePaths = await discoverRelatedSourceFiles(sourcePath);
    const args = buildCompileArgs(sourcePaths, outputPath);
    const timeout = options?.timeout ?? DEFAULT_TIMEOUT_MS;

    const result = await spawnProcess('g++', args, { timeout, signal: options?.signal });
    return { ...result, outputPath };
}

const CPP_SOURCE_EXTENSIONS = new Set(['.c', '.cc', '.cpp', '.cxx']);

/** Include all implementation files beside the active source for typical coursework projects. */
export async function discoverRelatedSourceFiles(sourcePath: string): Promise<string[]> {
    const directory = path.dirname(sourcePath);
    const entries = await readdir(directory, { withFileTypes: true });
    const related = entries
        .filter((entry) => entry.isFile() && CPP_SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
        .map((entry) => path.join(directory, entry.name))
        .sort((a, b) => a.localeCompare(b));

    return related.length > 0 ? related : [sourcePath];
}

export function buildCompileArgs(sourcePaths: string[], outputPath: string): string[] {
    return ['-std=c++17', '-O2', '-Wall', ...sourcePaths, '-o', outputPath];
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
    cwd?: string;
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
            cwd: options.cwd,
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
