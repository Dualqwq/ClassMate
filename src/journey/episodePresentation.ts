import type { JourneyEpisodeVM } from './journeyViewModel';

/** Shared with the webview so a help request carries the complete compiler evidence. */
export function buildJourneyHintText(episode: JourneyEpisodeVM): string {
    const displayName = episode.fileLabel ?? episode.fileName;
    const location = displayName ? `(${displayName}${episode.line ? `:${episode.line}` : ''})` : '';
    const request = `我在修这个错但一直没搞定：「${episode.message}」${location}。请先告诉我下一步应该从哪里排查，不要直接给完整代码。`;
    if (!episode.diagnosticDetails?.length) { return request; }
    return `${request}\n\n完整编译诊断：\n${episode.diagnosticDetails.map(d =>
        `${d.label}（${d.file ?? '未知文件'}${d.line ? `:${d.line}` : ''}）：${d.message}`
    ).join('\n')}`;
}
