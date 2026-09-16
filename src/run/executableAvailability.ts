import { stat } from 'fs/promises';
import type { ExecutableAvailability } from './types';

/** 只检查路径是否仍是文件，不承诺文件内容/权限一定允许启动。 */
export async function checkExecutableAvailability(
	candidate: string,
	readStat: (candidate: string) => Promise<{ isFile(): boolean }> = stat
): Promise<ExecutableAvailability> {
	try {
		return (await readStat(candidate)).isFile() ? 'available' : 'missing';
	} catch (error) {
		const code = (error as NodeJS.ErrnoException)?.code;
		return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unknown';
	}
}
