import type { LLMStreamCallbacks } from './types';

/**
 * Accumulate SSE (Server-Sent Events) text chunks and emit parsed tokens.
 *
 * Usage:
 *   const parser = createSseParser(callbacks);
 *   parser.feed(chunkText);
 *   parser.end();
 */
export interface SseParser {
	feed(chunk: string): void;
	end(): void;
}

export function createSseParser(callbacks: LLMStreamCallbacks): SseParser {
	let buffer = '';

	function processLine(line: string): void {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith(':')) {
			return;
		}

		if (trimmed === 'data: [DONE]') {
			return;
		}

		if (!trimmed.startsWith('data:')) {
			return;
		}

		const jsonText = trimmed.slice('data:'.length).trim();
		if (!jsonText) {
			return;
		}

		try {
			const chunk = JSON.parse(jsonText) as SseDataChunk;
			if (chunk.error) {
				throw new Error(chunk.error.message ?? 'Unknown API error');
			}

			const delta = extractDelta(chunk);
			if (delta) {
				callbacks.onToken(delta);
			}
		} catch (error) {
			if (error instanceof SyntaxError) {
				// Ignore malformed JSON lines; SSE can include empty or keep-alive lines.
				return;
			}
			callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
		}
	}

	return {
		feed(chunk: string): void {
			buffer += chunk;
			const lines = buffer.split('\n');
			// The last element may be an incomplete line; keep it in the buffer.
			buffer = lines.pop() ?? '';
			for (const line of lines) {
				processLine(line);
			}
		},
		end(): void {
			if (buffer.length > 0) {
				processLine(buffer);
				buffer = '';
			}
		},
	};
}

interface SseErrorChunk {
	error?: { message?: string };
}

interface OpenAIStyleChunk {
	choices?: Array<{
		delta?: { content?: string };
		finish_reason?: string | null;
	}>;
}

type SseDataChunk = SseErrorChunk & OpenAIStyleChunk;

function extractDelta(chunk: SseDataChunk): string | undefined {
	return chunk.choices?.[0]?.delta?.content;
}
