import * as React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import type { ChatReference } from '../../../src/chat/types';
import { inferenceLinkifyAnswer } from '../../../src/chat/answerReferenceRenderer';
import { transformReferenceUrl } from '../../../src/chat/linkifyAnswer';
import { sendMessage } from '../vscodeApi';

interface MarkdownRendererProps {
	content: string;
	references?: ChatReference[];
	/** 本轮工作区实际加载的代码文件,文件名补链目录(用户边界:文件名任意提及可链)。 */
	codeFiles?: string[];
}

const CodeBlock: React.FC<{ className?: string; children: string } > = ({
	className,
	children,
}) => {
	const match = /language-(\w+)/.exec(className || '');
	const language = match ? match[1] : 'text';

	return (
		<SyntaxHighlighter
			language={language}
			style={vscDarkPlus}
			customStyle={{
				margin: '8px 0',
				borderRadius: '6px',
				fontSize: '12px',
				background: 'var(--vscode-editor-background)',
			}}
			codeTagProps={{
				style: {
					fontFamily: 'var(--vscode-editor-font-family), monospace',
					fontSize: '12px',
				},
			}}
		>
			{String(children).replace(/\n$/, '')}
		</SyntaxHighlighter>
	);
};

export const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({ content, references, codeFiles }) => {
	// 只在引用就绪后(流结束后)叠加 inferred 补链(行内代码 + 唯一匹配 +
	// 工作区代码文件名任意提及),流式期间保持纯文本渲染;模型标记的链接
	// 已在正文里,不受影响。
	const hasInferenceInput = (references?.length ?? 0) > 0 || (codeFiles?.length ?? 0) > 0;
	const displayContent = hasInferenceInput
		? inferenceLinkifyAnswer(content, references ?? [], { codeFiles })
		: content;
	return (
		<ReactMarkdown
			remarkPlugins={[remarkGfm]}
			urlTransform={transformReferenceUrl}
			components={{
				code(props) {
					const { children, className, node, ref, ...rest } = props;
					void node;
					void ref;
					const isInline = !className;
					if (isInline) {
						// 语义着色:std:: 前缀 → std;限定名取末段查 references;全大写 → 宏;其余中性。
						const text = String(children ?? '').trim();
						let kindClass = '';
						if (text.startsWith('std::')) {
							kindClass = 'kind-std';
						} else {
							const tail = (text.split('::').pop() ?? text).trim();
							if (/^[A-Za-z_]\w*$/.test(tail)) {
								const matched = references?.find((r) => r.symbol === tail && r.kind);
								if (matched?.kind) {
									kindClass = `kind-${matched.kind}`;
								} else if (/^[A-Z][A-Z0-9_]*$/.test(tail)) {
									kindClass = 'kind-macro';
								}
							}
						}
						return (
							<code
								{...rest}
								className={[className, 'code-chip', kindClass].filter(Boolean).join(' ')}
							>
								{children}
							</code>
						);
					}
					return <CodeBlock className={className}>{children as string}</CodeBlock>;
				},
				pre({ children }) {
					return <>{children}</>;
				},
				a({ children, href }) {
					if (href?.startsWith('classmate-ref://')) {
						// ?i 后缀 = 渲染层保守补链(inferred);点击行为与模型标记链接一致,
						// 元数据随消息带给宿主做分层诊断。
						const match = /^classmate-ref:\/\/(\d+)(\?i)?$/.exec(href);
						const index = match ? Number(match[1]) : Number(href.slice('classmate-ref://'.length));
						const inferred = match?.[2] === '?i';
						const reference = references?.[index];
						const openReference = () => {
							if (reference) {
								sendMessage({ type: 'openReference', reference, inferred });
							}
						};
						return (
							// 不用带 href 的 <a>:VS Code 会拦截锚点点击并向宿主发 did-click-link,
							// 未知 scheme 没有 opener,导致链接"点不进去"。无 href + role=link
							// 可完全绕开拦截;样式与键盘交互由 .ref-code-link 提供。
							<a
								role="link"
								tabIndex={0}
								className="ref-code-link"
								onClick={openReference}
								onKeyDown={(e) => {
									if (e.key === 'Enter' || e.key === ' ') {
										e.preventDefault();
										openReference();
									}
								}}
							>
								{children}
							</a>
						);
					}
					return (
						<a
							href={href}
							target="_blank"
							rel="noreferrer"
							style={{
								color: 'var(--classmate-link-color, var(--vscode-textLink-foreground))',
								textDecoration: 'none',
							}}
							onMouseEnter={(e) => {
								e.currentTarget.style.textDecoration = 'underline';
							}}
							onMouseLeave={(e) => {
								e.currentTarget.style.textDecoration = 'none';
							}}
						>
							{children}
						</a>
					);
				},
				p({ children }) {
					return <p style={{ margin: '0 0 10px 0', lineHeight: '1.5' }}>{children}</p>;
				},
				ul({ children }) {
					return <ul style={{ margin: '0 0 10px 0', paddingLeft: '20px' }}>{children}</ul>;
				},
				ol({ children }) {
					return <ol style={{ margin: '0 0 10px 0', paddingLeft: '20px' }}>{children}</ol>;
				},
				li({ children }) {
					return <li style={{ marginBottom: '4px' }}>{children}</li>;
				},
				h1({ children }) {
					return <h1 style={{ margin: '16px 0 8px', fontSize: '18px', fontWeight: 600 }}>{children}</h1>;
				},
				h2({ children }) {
					return <h2 style={{ margin: '14px 0 8px', fontSize: '16px', fontWeight: 600 }}>{children}</h2>;
				},
				h3({ children }) {
					return <h3 style={{ margin: '12px 0 6px', fontSize: '14px', fontWeight: 600 }}>{children}</h3>;
				},
				h4({ children }) {
					return <h4 style={{ margin: '10px 0 6px', fontSize: '13px', fontWeight: 600 }}>{children}</h4>;
				},
				h5({ children }) {
					return <h5 style={{ margin: '8px 0 4px', fontSize: '12px', fontWeight: 600 }}>{children}</h5>;
				},
				h6({ children }) {
					return <h6 style={{ margin: '8px 0 4px', fontSize: '12px', fontWeight: 600 }}>{children}</h6>;
				},
				blockquote({ children }) {
					return (
						<blockquote
							style={{
								margin: '8px 0',
								padding: '8px 12px',
								borderLeft: '3px solid var(--vscode-panel-border)',
								background: 'var(--vscode-editor-inactiveSelectionBackground)',
								borderRadius: '0 6px 6px 0',
							}}
						>
							{children}
						</blockquote>
					);
				},
				hr() {
					return <hr style={{ border: 'none', borderTop: '1px solid var(--vscode-panel-border)', margin: '12px 0' }} />;
				},
				table({ children }) {
					return (
						<table
							style={{
								width: '100%',
								borderCollapse: 'collapse',
								margin: '10px 0',
								fontSize: '12px',
							}}
						>
							{children}
						</table>
					);
				},
				thead({ children }) {
					return <thead style={{ background: 'var(--vscode-editor-inactiveSelectionBackground)' }}>{children}</thead>;
				},
				th({ children }) {
					return (
						<th
							style={{
								border: '1px solid var(--vscode-panel-border)',
								padding: '6px 8px',
								textAlign: 'left',
								fontWeight: 600,
							}}
						>
							{children}
						</th>
					);
				},
				td({ children }) {
					return (
						<td
							style={{
								border: '1px solid var(--vscode-panel-border)',
								padding: '6px 8px',
								textAlign: 'left',
							}}
						>
							{children}
						</td>
					);
				},
				strong({ children }) {
					return <strong style={{ fontWeight: 700 }}>{children}</strong>;
				},
				em({ children }) {
					return <em style={{ fontStyle: 'italic' }}>{children}</em>;
				},
			}}
		>
			{displayContent}
		</ReactMarkdown>
	);
};
