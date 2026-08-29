/**
 * Composer 粘贴折叠(占位 token)纯函数模块。
 *
 * 学生往聊天输入框粘贴大段文字(整页报错日志、整份代码)时,输入框以
 * `[已粘贴 #1 12 行]` 这样的占位 token 代替几十行原文摊开。完整原文保存在
 * webview 侧内存映射(token → 原文)里,发送前由 `expandPasteTokens` 逐 token
 * 原样还原——占位只是显示层,模型收到的永远是完整原文,内容一条都不能丢。
 *
 * 降级底线(面板重载/持久化失败导致映射丢失时):
 * - 无映射的 token 原样可见,绝不静默吞内容;
 * - 发送前若仍存在无映射 token(`missingTokens` 非空)或残缺占位
 *   (`findBrokenPasteFragments` 非空),调用方必须拦截发送并提示用户,
 *   宁可不发也不发出残缺内容。
 *
 * 本模块必须保持纯 TS:不得 import 'vscode',不得触碰 DOM/window,
 * 供 webview bundle(esbuild)与 src/test(mocha/tsc)两侧共用
 * (先例:composerDraftContract.ts / classmateTheme.ts)。
 */

/**
 * 行数阈值:行数 ≥ 8 即折叠。
 *
 * 理由:composer 可视高度上限 132px(webview/classmate.css `.composer-input`
 * 的 max-height,行高 1.45 ≈ 20px/行)约容纳 6 行,8 行的粘贴必然已经溢出
 * 成滚动区,整页报错日志/整份代码都远超此量;阈值取 8 留出余量,保证正常
 * 的短提问(1–4 行)永远不会被折叠。
 */
export const PASTE_COLLAPSE_MIN_LINES = 8;

/**
 * 字符数阈值:字符数 ≥ 500 即折叠(与行数阈值满足其一即可)。
 *
 * 理由:兜住单行长内容——压缩 JSON、单行超长报错、成串链接等不触发行数
 * 阈值,但同样会把输入框撑成横向滚动区。500 字符约半屏文字,正常提问很少
 * 达到;两个条件取"或"是刻意宽松:宁可多折叠(有占位预览兜底),也不让
 * 大段原文摊开淹没输入框。
 */
export const PASTE_COLLAPSE_MIN_CHARS = 500;

/** 占位 token 的完整形态:`[已粘贴 #编号 行数 行]`,单行、无空白变体。 */
export const PASTE_TOKEN_PATTERN = /\[已粘贴 #(\d+) (\d+) 行\]/g;

const PASTE_TOKEN_EXACT = /^\[已粘贴 #(\d+) (\d+) 行\]$/;

export interface PasteTokenInfo {
	serial: number;
	lineCount: number;
}

/** 粘贴内容在映射里保存的记录形态(webview 内存与持久化共用同一形状)。 */
export interface ComposerPasteRecord {
	/** 完整原文;发送前经 expandPasteTokens 原样还原,一字不改。 */
	content: string;
	/** 构建占位时的行数快照,用于 chip 展示与删除反馈文案。 */
	lineCount: number;
	/** 占位编号,与 token 字符串中一致。 */
	serial: number;
}

export function buildPasteToken(serial: number, lineCount: number): string {
	return `[已粘贴 #${serial} ${lineCount} 行]`;
}

/** 解析合法 token;任何不符合完整形态的字符串返回 undefined。 */
export function parsePasteToken(token: string): PasteTokenInfo | undefined {
	const match = PASTE_TOKEN_EXACT.exec(token);
	if (!match) {
		return undefined;
	}
	return { serial: Number(match[1]), lineCount: Number(match[2]) };
}

/** 行数:按换行符切分;末尾单个换行是行结束符,不计作额外一行。 */
export function countLines(text: string): number {
	if (!text) {
		return 0;
	}
	const body = text.endsWith('\n') ? text.slice(0, -1) : text;
	return body.split('\n').length;
}

/** 是否应折叠为占位:行数或字符数任一达到阈值即折叠;空文本永不折叠。 */
export function shouldCollapsePaste(text: string): boolean {
	if (!text) {
		return false;
	}
	return (
		countLines(text) >= PASTE_COLLAPSE_MIN_LINES ||
		text.length >= PASTE_COLLAPSE_MIN_CHARS
	);
}

/**
 * 为一次新粘贴挑选不与既有内容冲突的编号。
 *
 * `isTaken` 由调用方提供(输入框当前值是否包含该 token 字符串 + 当前映射
 * 是否已占用该 token 字符串)。若直接采用 desiredSerial 会与框内既有 token
 * 或映射键撞车,新占位就会共享同一份映射,发送时还原出错内容,因此逐个后移。
 */
export function findUniquePasteSerial(
	isTaken: (token: string) => boolean,
	desiredSerial: number,
	lineCount: number
): number {
	let serial = Math.max(1, Math.floor(desiredSerial));
	while (isTaken(buildPasteToken(serial, lineCount))) {
		serial += 1;
	}
	return serial;
}

/** 输入框当前值里出现的全部合法占位 token,按首次出现顺序去重。 */
export function findActivePasteTokens(value: string): string[] {
	const tokens: string[] = [];
	for (const match of value.matchAll(PASTE_TOKEN_PATTERN)) {
		const token = match[0];
		if (!tokens.includes(token)) {
			tokens.push(token);
		}
	}
	return tokens;
}

export interface PasteExpansionResult {
	/**
	 * 还原后的完整文本。有映射的 token 原文逐字替换(单趟替换,还原出的
	 * 原文不会再被扫描);无映射的 token 原样保留在 text 里。
	 */
	text: string;
	/**
	 * 无映射的 token(去重、按出现顺序)。非空时调用方必须拦截发送并提示
	 * 用户,绝不把残缺内容发出去。
	 */
	missingTokens: string[];
}

/**
 * 发送前还原:把 value 中每个有映射的 token 替换为完整原文,其余字符
 * (包括用户手打的文字)原样保留。resolve 返回 undefined 表示映射丢失。
 */
export function expandPasteTokens(
	value: string,
	resolve: (token: string) => string | undefined
): PasteExpansionResult {
	const missingTokens: string[] = [];
	const text = value.replace(PASTE_TOKEN_PATTERN, (token) => {
		const content = resolve(token);
		if (content === undefined) {
			if (!missingTokens.includes(token)) {
				missingTokens.push(token);
			}
			return token;
		}
		return content;
	});
	return { text, missingTokens };
}

/** previousValue 中有而 currentValue 中没有的 token(去重、按旧值顺序)。 */
export function findRemovedPasteTokens(
	previousValue: string,
	currentValue: string
): string[] {
	return findActivePasteTokens(previousValue).filter(
		(token) => !currentValue.includes(token)
	);
}

/**
 * 被部分编辑(残缺)的占位片段。
 *
 * 先把完整合法 token 从值里剥掉,剩下的 `[已粘贴…` 开头片段即为残缺占位:
 * 它们不会匹配 PASTE_TOKEN_PATTERN,若不拦截会以字面文本发出、对应原文被
 * 静默丢弃(如用户删掉了结尾的 `]`,或删了后半截)。完整片段超过 40 字符
 * 的按前 40 字符报告,仅用于存在性判断与提示。
 */
export function findBrokenPasteFragments(value: string): string[] {
	const withoutValidTokens = value.replace(PASTE_TOKEN_PATTERN, '');
	return withoutValidTokens.match(/\[已粘贴[^\]\n]{0,40}/g) ?? [];
}
