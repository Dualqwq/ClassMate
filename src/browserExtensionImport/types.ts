/**
 * 浏览器扩展向 VS Code 本地 HTTP 端点发送的题目导入请求。
 */
export interface BrowserExtensionImportRequest {
	/** 网页标题，可选地作为 README.md 的 YAML frontmatter 标题。 */
	title?: string;
	/** 已转换为 Markdown 的网页正文/选区。 */
	markdown: string;
	/** 来源网页 URL，可选。 */
	url?: string;
}

/**
 * 本地 HTTP 端点健康检查响应。
 */
export interface BrowserExtensionHealthResponse {
	ok: boolean;
	port: number;
}
