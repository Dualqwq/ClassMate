/**
 * ClassMate 浏览器扩展内容脚本：读取页面选区并转换为轻量 Markdown。
 *
 * 本实现参考 yorkxin/copy-as-markdown(MIT License)的轻量自研思路，
 * 未引入 Turndown/Readability 等第三方库，转换规则保持最小可用。
 */

(function () {
	'use strict';

	/**
	 * 获取用户当前选中的文本，并包装为 Markdown。
	 */
	function getSelectionMarkdown() {
		const selection = window.getSelection();
		if (!selection || selection.rangeCount === 0) {
			return '';
		}
		const range = selection.getRangeAt(0);
		const fragment = range.cloneContents();
		return fragmentToMarkdown(fragment);
	}

	/**
	 * 将 DocumentFragment 转为简单 Markdown。
	 * 规则：段落之间加空行；<pre><code> 转为围栏代码块；<a> 转为链接；
	 * 标题按标签级别转 #；粗体/斜体按语义保留；其他块元素简单换行。
	 */
	function fragmentToMarkdown(fragment) {
		const container = document.createElement('div');
		container.appendChild(fragment);
		return nodeToMarkdown(container).trim();
	}

	/**
	 * 从公式渲染根节点提取唯一一份 LaTeX 源码。
	 * KaTeX 把公式渲染成 .katex-mathml(隐藏 MathML 副本,内含 mrow 文本 +
	 * annotation 两份)+ .katex-html(可见副本);MathJax v3 是 mjx-container +
	 * mjx-assistive-mml。通用 DOM 遍历会把副本全部收进输出($N$ 变 NNN)。
	 * 优先取 annotation[encoding="application/x-tex"] 的原始 LaTeX 源码,
	 * 而不是从渲染 DOM 反推。返回 null 表示不是公式根节点。
	 */
	function extractMathSource(element, tag) {
		// KaTeX:display 外层是 .katex-display > .katex,先判外层。
		if (element.classList.contains('katex-display') || element.classList.contains('katex')) {
			const source = element.querySelector('annotation[encoding="application/x-tex"]')?.textContent ?? '';
			const latex = source.trim();
			return latex ? { latex, display: element.classList.contains('katex-display') } : null;
		}
		if (tag === 'mjx-container') {
			// MathJax v3:原始 LaTeX 存于 assistive MathML 的 annotation;display 块有 display="block" 属性。
			const source = element.querySelector('annotation[encoding="application/x-tex"]')?.textContent ?? '';
			const latex = source.trim();
			return latex ? { latex, display: element.getAttribute('display') === 'block' } : null;
		}
		if (tag === 'math') {
			const annotation = element.querySelector('annotation[encoding="application/x-tex"]');
			let latex = annotation?.textContent?.trim() ?? '';
			if (!latex) {
				// 纯 MathML(无 annotation):克隆后摘掉 annotation 再取文本,
				// 否则 semantics 正文与 annotation 相加会双份($N$ 的 MathML 文本即 NN)。
				const clone = /** @type {Element} */ (element.cloneNode(true));
				clone.querySelectorAll('annotation').forEach((node) => node.remove());
				latex = (clone.textContent ?? '').replace(/\s+/g, ' ').trim();
			}
			return latex ? { latex, display: element.getAttribute('display') === 'block' } : null;
		}
		return null;
	}

	/**
	 * 递归将 DOM 节点转为 Markdown 字符串。
	 */
	function nodeToMarkdown(node) {
		if (node.nodeType === Node.TEXT_NODE) {
			return node.textContent ?? '';
		}
		if (node.nodeType !== Node.ELEMENT_NODE) {
			return '';
		}

		const element = /** @type {Element} */ (node);
		const tag = element.tagName.toLowerCase();

		// 公式渲染根节点(KaTeX/MathJax/MathML):输出唯一一份 LaTeX 源并停止下钻。
		// 这类库把同一公式渲染成多份 DOM 副本,通用遍历会收集多次且丢 $ 定界符
		// ($N$ 变 NNN)。取不到源码时返回 null 交由下方副本守卫兜底。
		const math = extractMathSource(element, tag);
		if (math) {
			return math.display ? `\n\n$$${math.latex}$$\n\n` : `$${math.latex}$`;
		}

		// 渲染库的孤儿副本(选区起点落在公式内部、克隆不到外层根节点时出现):
		// 隐藏副本(.katex-mathml/mjx-assistive-mml)直接丢弃;可见副本只保留一份
		// 纯文本——两条路都保证同一公式不会被重复输出。
		if (tag === 'mjx-assistive-mml' || element.classList.contains('katex-mathml')) {
			return '';
		}
		if (element.classList.contains('katex-html')) {
			return (element.textContent ?? '').trim();
		}

		const children = Array.from(element.childNodes).map(nodeToMarkdown).join('');

		switch (tag) {
			case 'h1': return `\n\n# ${inlineClean(children)}\n\n`;
			case 'h2': return `\n\n## ${inlineClean(children)}\n\n`;
			case 'h3': return `\n\n### ${inlineClean(children)}\n\n`;
			case 'h4': return `\n\n#### ${inlineClean(children)}\n\n`;
			case 'h5': return `\n\n##### ${inlineClean(children)}\n\n`;
			case 'h6': return `\n\n###### ${inlineClean(children)}\n\n`;
			case 'p': return `\n\n${inlineClean(children)}\n\n`;
			case 'br': return '\n';
			case 'hr': return '\n\n---\n\n';
			case 'a': {
				const href = element.getAttribute('href') ?? '';
				const text = inlineClean(children);
				return `[${text}](${href})`;
			}
			case 'img': {
				const src = element.getAttribute('src') ?? '';
				const alt = element.getAttribute('alt') ?? '';
				return `![${alt}](${src})`;
			}
			case 'strong':
			case 'b': return `**${inlineClean(children)}**`;
			case 'em':
			case 'i': return `*${inlineClean(children)}*`;
			case 'code': return `\`${children.replace(/`/g, '\\`')}\``;
			case 'pre': {
				// 如果内部有 code 标签，优先取其文本；否则整体作为代码块。
				const code = element.querySelector('code');
				const codeText = code ? code.textContent ?? children : children;
				const lang = code?.getAttribute('class')?.replace(/^language-/, '') ?? '';
				return `\n\n\`\`\`${lang}\n${codeText.trim()}\n\`\`\`\n\n`;
			}
			case 'ul': {
				const items = Array.from(element.children)
					.map((li) => `- ${nodeToMarkdown(li).trim()}`)
					.join('\n');
				return `\n\n${items}\n\n`;
			}
			case 'ol': {
				const items = Array.from(element.children)
					.map((li, index) => `${index + 1}. ${nodeToMarkdown(li).trim()}`)
					.join('\n');
				return `\n\n${items}\n\n`;
			}
			case 'li': return inlineClean(children);
			case 'script': {
				// MathJax v2 在 DOM 中保留原始 LaTeX 源 <script type="math/tex">,
				// 直接取源码包定界符;其余脚本一律不输出。
				const scriptType = element.getAttribute('type') ?? '';
				if (!scriptType.startsWith('math/tex')) {
					return '';
				}
				const latex = (element.textContent ?? '').trim();
				return scriptType.includes('mode=display')
					? `\n\n$$${latex}$$\n\n`
					: `$${latex}$`;
			}
			case 'blockquote': return `\n\n> ${inlineClean(children).replace(/\n/g, '\n> ')}\n\n`;
			case 'div':
			case 'section':
			case 'article':
			case 'main':
			case 'header':
			case 'footer': return `\n\n${children.trim()}\n\n`;
			default: return children;
		}
	}

	function inlineClean(text) {
		return text
			.replace(/[ \t]+/g, ' ')
			.replace(/\n{3,}/g, '\n\n')
			.trim();
	}

	/**
	 * 获取页面主要文本内容（无选区时的降级来源）。
	 * 优先取 <article>、<main>，否则取 <body>，并做简单去噪。
	 */
	function getPageBodyMarkdown() {
		const root = document.querySelector('article, main') ?? document.body;
		if (!root) {
			return '';
		}
		return nodeToMarkdown(root).trim();
	}

	/**
	 * 暴露给 popup/background 调用的统一入口。
	 */
	function collectProblemInfo() {
		const selectionMarkdown = getSelectionMarkdown();
		return {
			title: document.title,
			url: location.href,
			markdown: selectionMarkdown || getPageBodyMarkdown(),
			selectionUsed: selectionMarkdown.length > 0,
		};
	}

	// 接收 popup/background 的收集请求，返回当前页面/选区的 Markdown。
	chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
		if (message?.type === 'classmate-collect') {
			const info = collectProblemInfo();
			console.log(`[ClassMate content] collect: selection=${info.selectionUsed ? 'yes' : 'no'}, markdown ${info.markdown.length} chars`);
			sendResponse(info);
			return true;
		}
		return false;
	});
})();
