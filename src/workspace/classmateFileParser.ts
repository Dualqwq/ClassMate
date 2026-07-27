import * as vscode from 'vscode';
import matter = require('gray-matter');
import type { CourseContext } from './types';

const MAX_CLASSMATE_BYTES = 64 * 1024;
const MAX_FIELD_LENGTH = 500;
const MAX_BODY_LENGTH = 12_000;

export interface ParsedClassmateFile {
    context?: CourseContext;
    warnings: string[];
    contentHash?: string;
}

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

function limitedString(value: unknown, field: string, warnings: string[]): string | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }
    const normalized = value.replace(/\u0000/g, '').trim();
    if (normalized.length <= MAX_FIELD_LENGTH) {
        return normalized || undefined;
    }
    warnings.push(`${field} exceeded ${MAX_FIELD_LENGTH} characters and was truncated.`);
    return normalized.slice(0, MAX_FIELD_LENGTH);
}

/**
 * Parse a CLASSMATE.md file into a structured course context object.
 *
 * Expected format: YAML frontmatter + Markdown body.
 */
export async function parseClassmateMdDetailed(uri: vscode.Uri): Promise<ParsedClassmateFile> {
    const warnings: string[] = [];
    try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.size > MAX_CLASSMATE_BYTES) {
            return {
                warnings: [`CLASSMATE.md exceeds the ${MAX_CLASSMATE_BYTES}-byte safety limit.`],
            };
        }
        const rawBytes = await vscode.workspace.fs.readFile(uri);
        if (rawBytes.byteLength > MAX_CLASSMATE_BYTES) {
            return {
                warnings: [`CLASSMATE.md exceeds the ${MAX_CLASSMATE_BYTES}-byte safety limit.`],
            };
        }
        const raw = Buffer.from(rawBytes).toString('utf-8');
        const parsed = matter(raw);

        const data = parsed.data ?? {};
        const allowedKeys = new Set(['course', 'current_concept', 'prerequisites', 'teaching_strategy']);
        for (const key of Object.keys(data)) {
            if (!allowedKeys.has(key)) {
                warnings.push(`Ignored unsupported CLASSMATE.md field: ${key}`);
            }
        }

        const rawBody = typeof parsed.content === 'string'
            ? parsed.content.replace(/\u0000/g, '').trim()
            : '';
        const body = rawBody.length > MAX_BODY_LENGTH
            ? rawBody.slice(0, MAX_BODY_LENGTH)
            : rawBody;
        if (rawBody.length > MAX_BODY_LENGTH) {
            warnings.push(`CLASSMATE.md body exceeded ${MAX_BODY_LENGTH} characters and was truncated.`);
        }

        return {
            context: {
                course: limitedString(data.course, 'course', warnings),
                currentConcept: limitedString(data.current_concept, 'current_concept', warnings),
                prerequisites: toStringArray(data.prerequisites)
                    .map((item) => limitedString(item, 'prerequisites item', warnings))
                    .filter((item): item is string => item !== undefined)
                    .slice(0, 20),
                teachingStrategy: limitedString(data.teaching_strategy, 'teaching_strategy', warnings),
                body,
            },
            warnings,
            contentHash: (await import('crypto')).createHash('sha256').update(raw, 'utf8').digest('hex'),
        };
    } catch (error) {
        return {
            warnings: [
                `Unable to parse CLASSMATE.md: ${error instanceof Error ? error.message : String(error)}`,
            ],
        };
    }
}

export async function parseClassmateMd(uri: vscode.Uri): Promise<CourseContext | undefined> {
    return (await parseClassmateMdDetailed(uri)).context;
}
