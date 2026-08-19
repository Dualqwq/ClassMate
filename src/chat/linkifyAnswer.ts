interface Segment {
	text: string;
	kind: 'plain' | 'code-block' | 'inline-code' | 'link';
}

/**
 * react-markdown 的 urlTransform:放行 classmate-ref://(含渲染层补链的
 * ?i 后缀),其余交给默认安全规则(未知协议置空,避免 LLM 输出里的可疑
 * scheme 进入 DOM)。
 */
const SAFE_PROTOCOL = /^(https?|ircs?|mailto|xmpp)$/i;

export function transformReferenceUrl(value: string): string {
	if (value.startsWith('classmate-ref://')) {
		return value;
	}
	const colon = value.indexOf(':');
	const questionMark = value.indexOf('?');
	const numberSign = value.indexOf('#');
	const slash = value.indexOf('/');
	if (
		colon === -1 ||
		(slash !== -1 && colon > slash) ||
		(questionMark !== -1 && colon > questionMark) ||
		(numberSign !== -1 && colon > numberSign) ||
		SAFE_PROTOCOL.test(value.slice(0, colon))
	) {
		return value;
	}
	return '';
}

/**
 * markdown 感知切分:代码块、行内代码、已有链接(含 classmate-ref://N 与
 * 带 ?i 后缀的形态)原样保留,其余为正文。展示层补链
 * (answerReferenceRenderer)与旧提取路径共用本切分。
 */
export function tokenizeMarkdown(content: string): Segment[] {
	const segments: Segment[] = [];
	let i = 0;
	while (i < content.length) {
		if (content.startsWith('```', i)) {
			const end = content.indexOf('```', i + 3);
			if (end === -1) {
				segments.push({ text: content.slice(i), kind: 'code-block' });
				break;
			}
			segments.push({ text: content.slice(i, end + 3), kind: 'code-block' });
			i = end + 3;
			continue;
		}
		if (content[i] === '`') {
			const end = content.indexOf('`', i + 1);
			if (end === -1) {
				segments.push({ text: content.slice(i), kind: 'inline-code' });
				break;
			}
			segments.push({ text: content.slice(i, end + 1), kind: 'inline-code' });
			i = end + 1;
			continue;
		}
		if (content[i] === '[') {
			const close = content.indexOf('](', i);
			if (close !== -1) {
				const urlEnd = content.indexOf(')', close + 2);
				if (urlEnd !== -1) {
					segments.push({ text: content.slice(i, urlEnd + 1), kind: 'link' });
					i = urlEnd + 1;
					continue;
				}
			}
		}
		let next = i + 1;
		while (next < content.length) {
			const ch = content[next];
			if (ch === '`' || ch === '[' || content.startsWith('```', next)) {
				break;
			}
			next++;
		}
		segments.push({ text: content.slice(i, next), kind: 'plain' });
		i = next;
	}
	return segments;
}
