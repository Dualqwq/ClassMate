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
