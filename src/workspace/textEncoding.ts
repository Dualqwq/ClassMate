import * as jschardet from 'jschardet';
import * as iconv from 'iconv-lite';

/**
 * jschardet 对 GB 系列编码的命名。目标用户(Windows 中文初学者)的源码与文档
 * 常是 GBK/GB2312;GB18030 是前两者的超集,统一用 gb18030 解码即可全覆盖。
 */
const GB_FAMILY_ENCODINGS = new Set(['GB2312', 'GBK', 'GB18030']);

/**
 * 解码"未在编辑器打开"的磁盘文本文件:jschardet 探测到 GB 家族时用 iconv-lite
 * 解码,其余情况(UTF-8、ASCII、探测为 null/不确定)回退 utf8,与原硬编码
 * `toString('utf8')` 行为一致。已在编辑器打开的文档仍走 TextDocument.getText(),
 * 由 VS Code 自行处理编码,不经此函数。
 */
export function decodeDiskTextFile(bytes: Uint8Array): string {
	const buffer = Buffer.from(bytes);
	const encoding = jschardet.detect(buffer).encoding?.toUpperCase();
	if (encoding && GB_FAMILY_ENCODINGS.has(encoding)) {
		return iconv.decode(buffer, 'gb18030');
	}
	return buffer.toString('utf8');
}
