import * as vscode from 'vscode';
import matter = require('gray-matter');
import type { CourseContext } from './types';

function toStringArray(value: unknown): string[] {
    if (Array.isArray(value)) {
        return value
            .map((item) => (typeof item === 'string' ? item : String(item)))
            .filter((item) => item.length > 0);
    }
    if (typeof value === 'string') {
        return value.split(',').map((s) => s.trim()).filter(Boolean);
    }
    return [];
}

/**
 * Parse a CLASSMATE.md file into a structured course context object.
 *
 * Expected format: YAML frontmatter + Markdown body.
 */
export async function parseClassmateMd(uri: vscode.Uri): Promise<CourseContext | undefined> {
    try {
        const rawBytes = await vscode.workspace.fs.readFile(uri);
        const raw = Buffer.from(rawBytes).toString('utf-8');
        const parsed = matter(raw);

        const data = parsed.data ?? {};
        const body = typeof parsed.content === 'string' ? parsed.content : '';

        return {
            course: typeof data.course === 'string' ? data.course : undefined,
            currentConcept: typeof data.current_concept === 'string' ? data.current_concept : undefined,
            prerequisites: toStringArray(data.prerequisites),
            teachingStrategy: typeof data.teaching_strategy === 'string' ? data.teaching_strategy : undefined,
            body,
        };
    } catch {
        return undefined;
    }
}
