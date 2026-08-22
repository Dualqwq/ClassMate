import * as assert from 'assert';
import { describe, it } from 'mocha';
import { formatCoursewareContext } from '../../courseware/coursewarePromptInjector';
import type { CoursewareRetrievalResult } from '../../courseware/types';

describe('courseware prompt injector', () => {
	it('renders retrieved fragments as a context block', () => {
		const results: CoursewareRetrievalResult[] = [{
			chunkId: 'a#0',
			sourceId: 'a',
			fileName: 'lecture.pdf',
			pageStart: 2,
			pageEnd: 3,
			content: 'A class is a blueprint.',
			score: 1.2,
		}];
		const context = formatCoursewareContext(results);
		assert.match(context, /Courseware context/);
		assert.match(context, /lecture\.pdf \(p\.2-3\)/);
		assert.match(context, /A class is a blueprint/);
	});

	it('renders a single page without a range', () => {
		const results: CoursewareRetrievalResult[] = [{
			chunkId: 'a#0',
			sourceId: 'a',
			fileName: 'lecture.pdf',
			pageStart: 5,
			pageEnd: 5,
			content: 'Pointers store addresses.',
			score: 0.9,
		}];
		const context = formatCoursewareContext(results);
		assert.match(context, /lecture\.pdf \(p\.5\)/);
	});

	it('returns a no-match marker when results are empty', () => {
		const context = formatCoursewareContext([]);
		assert.match(context, /No matching courseware fragments found/);
	});
});
