import * as assert from 'assert';
import { describe, it } from 'mocha';
import * as iconv from 'iconv-lite';
import { decodeDiskTextFile } from '../workspace/textEncoding';

const GBK_SOURCE = [
	'#include <stdio.h>',
	'// 计算两个整数的最大公约数',
	'int gcd(int a, int b) {',
	'    // 辗转相除法:不断用余数替换被除数',
	'    return b == 0 ? a : gcd(b, a % b);',
	'}',
	'int main() {',
	'    printf("%d\\n", gcd(12, 18)); // 输出 6',
	'    return 0;',
	'}',
	'',
].join('\n');

describe('decodeDiskTextFile', () => {
	it('decodes GBK-encoded Chinese comments without mojibake', () => {
		const gbkBytes = iconv.encode(GBK_SOURCE, 'gbk');
		assert.strictEqual(decodeDiskTextFile(gbkBytes), GBK_SOURCE);
	});

	it('keeps UTF-8 content (with Chinese) unchanged', () => {
		const utf8Bytes = Buffer.from(GBK_SOURCE, 'utf8');
		assert.strictEqual(decodeDiskTextFile(utf8Bytes), GBK_SOURCE);
	});

	it('keeps UTF-8 BOM behavior identical to the previous hard-coded utf8 decode', () => {
		const utf8Bytes = Buffer.concat([
			Buffer.from([0xEF, 0xBB, 0xBF]),
			Buffer.from('hello 世界', 'utf8'),
		]);
		assert.strictEqual(decodeDiskTextFile(utf8Bytes), utf8Bytes.toString('utf8'));
	});

	it('decodes pure ASCII as utf8 (identical bytes)', () => {
		const ascii = 'int main() { return 0; }\n';
		assert.strictEqual(decodeDiskTextFile(Buffer.from(ascii, 'ascii')), ascii);
	});

	it('falls back to utf8 for empty buffers without throwing', () => {
		assert.strictEqual(decodeDiskTextFile(Buffer.alloc(0)), '');
	});

	it('falls back to utf8 for undetectable byte sequences without throwing', () => {
		const weird = Buffer.from([0x00, 0xFF, 0xFE, 0x41, 0x42, 0x80, 0x81]);
		assert.strictEqual(decodeDiskTextFile(weird), weird.toString('utf8'));
	});
});
