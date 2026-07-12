import * as assert from 'assert';
import { describe, it } from 'mocha';
import { extractErrorLocation, parseCompilerStderr } from '../error/errorParser';

describe('Error Parser', () => {
	it('parses GCC error with file, line, column', () => {
		const line = 'main.cpp:12:34: error: \'x\' was not declared in this scope';
		const parsed = extractErrorLocation(line);
		assert.ok(parsed);
		assert.strictEqual(parsed?.file, 'main.cpp');
		assert.strictEqual(parsed?.line, 12);
		assert.strictEqual(parsed?.column, 34);
		assert.strictEqual(parsed?.severity, 'error');
		assert.strictEqual(parsed?.message, "'x' was not declared in this scope");
	});

	it('parses GCC error without column', () => {
		const line = 'main.cpp:12: error: expected \';\' before \'return\'';
		const parsed = extractErrorLocation(line);
		assert.ok(parsed);
		assert.strictEqual(parsed?.file, 'main.cpp');
		assert.strictEqual(parsed?.line, 12);
		assert.strictEqual(parsed?.column, undefined);
		assert.strictEqual(parsed?.severity, 'error');
	});

	it('parses GCC warning', () => {
		const line = 'main.cpp:5:10: warning: unused variable \'x\' [-Wunused-variable]';
		const parsed = extractErrorLocation(line);
		assert.ok(parsed);
		assert.strictEqual(parsed?.severity, 'warning');
		assert.strictEqual(parsed?.message, "unused variable 'x'");
		assert.strictEqual(parsed?.code, '-Wunused-variable');
	});

	it('parses Clang error with diagnostic code', () => {
		const line = "main.cpp:7:9: error: use of undeclared identifier 'x' [-Werror,-Wundefined-identifier]";
		const parsed = extractErrorLocation(line);
		assert.ok(parsed);
		assert.strictEqual(parsed?.file, 'main.cpp');
		assert.strictEqual(parsed?.line, 7);
		assert.strictEqual(parsed?.column, 9);
		assert.strictEqual(parsed?.severity, 'error');
		assert.strictEqual(parsed?.message, "use of undeclared identifier 'x'");
		assert.strictEqual(parsed?.code, '-Wundefined-identifier');
	});

	it('parses Clang note with multiple codes', () => {
		const line = 'helper.cpp:3:5: note: declared here [-Wnote,-Wsome-other]';
		const parsed = extractErrorLocation(line);
		assert.ok(parsed);
		assert.strictEqual(parsed?.severity, 'note');
		assert.strictEqual(parsed?.message, 'declared here');
		assert.strictEqual(parsed?.code, '-Wnote');
	});

	it('parses Windows absolute path', () => {
		const line = 'C:\\\\Users\\\\dev\\\\main.cpp:42:10: error: invalid syntax';
		const parsed = extractErrorLocation(line);
		assert.ok(parsed);
		assert.strictEqual(parsed?.file, 'C:\\\\Users\\\\dev\\\\main.cpp');
		assert.strictEqual(parsed?.line, 42);
		assert.strictEqual(parsed?.column, 10);
		assert.strictEqual(parsed?.severity, 'error');
	});

	it('parses "In file included from" context note', () => {
		const line = 'In file included from main.cpp:1:';
		const parsed = extractErrorLocation(line);
		assert.ok(parsed);
		assert.strictEqual(parsed?.file, 'main.cpp');
		assert.strictEqual(parsed?.line, 1);
		assert.strictEqual(parsed?.severity, 'note');
		assert.strictEqual(parsed?.isIncludeContext, true);
	});

	it('ignores caret lines', () => {
		const line = '     ^~~~~';
		const parsed = extractErrorLocation(line);
		assert.strictEqual(parsed, undefined);
	});

	it('ignores Clang range highlight lines', () => {
		const line = '   ~~~~^~~~';
		const parsed = extractErrorLocation(line);
		assert.strictEqual(parsed, undefined);
	});

	it('returns undefined for linker errors without location', () => {
		const line = 'undefined reference to \'foo\'';
		const parsed = extractErrorLocation(line);
		assert.strictEqual(parsed, undefined);
	});

	it('parses GCC template instantiation note', () => {
		const line = 'main.cpp:8:20: note:   template argument deduction/substitution failed:';
		const parsed = extractErrorLocation(line);
		assert.ok(parsed);
		assert.strictEqual(parsed?.file, 'main.cpp');
		assert.strictEqual(parsed?.line, 8);
		assert.strictEqual(parsed?.column, 20);
		assert.strictEqual(parsed?.severity, 'note');
		assert.ok(parsed?.message.includes('template argument'));
	});

	it('parses GCC "required from here" note', () => {
		const line = 'main.cpp:10:5: note: required from here';
		const parsed = extractErrorLocation(line);
		assert.ok(parsed);
		assert.strictEqual(parsed?.severity, 'note');
		assert.strictEqual(parsed?.message, 'required from here');
	});

	it('parses GCC collect2 linker error with location', () => {
		const line = '/tmp/ccabc123.o: in function `main\': main.cpp:(.text+0x1f): undefined reference to `foo\'';
		const parsed = extractErrorLocation(line);
		// We do not yet parse linker object-file locations, so this should be undefined.
		assert.strictEqual(parsed, undefined);
	});

	it('parses Clang error with fix-it hint suffix', () => {
		const line = "main.cpp:4:11: error: expected ';' after expression [clang-diagnostic-error]";
		const parsed = extractErrorLocation(line);
		assert.ok(parsed);
		assert.strictEqual(parsed?.file, 'main.cpp');
		assert.strictEqual(parsed?.line, 4);
		assert.strictEqual(parsed?.column, 11);
		assert.strictEqual(parsed?.severity, 'error');
		assert.strictEqual(parsed?.message, "expected ';' after expression");
		assert.strictEqual(parsed?.code, 'clang-diagnostic-error');
	});

	it('prefers -W code when both -W and clang-diagnostic are present', () => {
		const line = "main.cpp:9:5: error: invalid conversion [clang-diagnostic-error, -Wconversion]";
		const parsed = extractErrorLocation(line);
		assert.ok(parsed);
		assert.strictEqual(parsed?.code, '-Wconversion');
	});

	it('parses Clang fatal error', () => {
		const line = 'fatal error: \'missing.h\' file not found';
		const parsed = extractErrorLocation(line);
		assert.strictEqual(parsed, undefined);
	});

	it('parses GCC fatal error', () => {
		const line = 'fatal error: no input files';
		const parsed = extractErrorLocation(line);
		assert.strictEqual(parsed, undefined);
	});

	it('parses multi-line GCC message line', () => {
		const line = 'main.cpp:15:6: error: conflicting declaration \'char x\'';
		const parsed = extractErrorLocation(line);
		assert.ok(parsed);
		assert.strictEqual(parsed?.severity, 'error');
		assert.strictEqual(parsed?.message, "conflicting declaration 'char x'");
	});

	it('parses GCC warning with -W flag but no column', () => {
		const line = 'main.cpp:3: warning: control reaches end of non-void function [-Wreturn-type]';
		const parsed = extractErrorLocation(line);
		assert.ok(parsed);
		assert.strictEqual(parsed?.file, 'main.cpp');
		assert.strictEqual(parsed?.line, 3);
		assert.strictEqual(parsed?.column, undefined);
		assert.strictEqual(parsed?.severity, 'warning');
		assert.strictEqual(parsed?.message, 'control reaches end of non-void function');
		assert.strictEqual(parsed?.code, '-Wreturn-type');
	});

	it('parses Clang warning with code only at end', () => {
		const line = "main.cpp:9:1: warning: comparison of integers of different signs: 'int' and 'unsigned int' [-Wsign-compare]";
		const parsed = extractErrorLocation(line);
		assert.ok(parsed);
		assert.strictEqual(parsed?.severity, 'warning');
		assert.strictEqual(parsed?.message, "comparison of integers of different signs: 'int' and 'unsigned int'");
		assert.strictEqual(parsed?.code, '-Wsign-compare');
	});

	it('parses Windows forward slash path', () => {
		const line = 'C:/Users/dev/main.cpp:8:5: error: something is wrong';
		const parsed = extractErrorLocation(line);
		assert.ok(parsed);
		assert.strictEqual(parsed?.file, 'C:/Users/dev/main.cpp');
		assert.strictEqual(parsed?.line, 8);
		assert.strictEqual(parsed?.column, 5);
	});

	it('ignores GCC location-less note', () => {
		const line = 'note: (if you use \'-fconcepts\', you will get a different error)';
		const parsed = extractErrorLocation(line);
		assert.strictEqual(parsed, undefined);
	});

	it('parseCompilerStderr filters non-diagnostic lines', () => {
		const stderr = [
			'In file included from main.cpp:1:',
			'main.cpp:5:10: error: missing semicolon',
			'    int x = 1',
			'          ^',
			'main.cpp:6:1: note: expected \';\' after expression',
		].join('\n');

		const parsed = parseCompilerStderr(stderr);
		assert.strictEqual(parsed.length, 3);
		assert.strictEqual(parsed[0].isIncludeContext, true);
		assert.strictEqual(parsed[1].severity, 'error');
		assert.strictEqual(parsed[2].severity, 'note');
	});

	it('parses Clang source range format', () => {
		const line = 'exprs.c:47:15:{47:8-47:14}{47:17-47:24}: error: invalid operands to binary expression';
		const parsed = extractErrorLocation(line);
		assert.ok(parsed);
		assert.strictEqual(parsed?.file, 'exprs.c');
		assert.strictEqual(parsed?.line, 47);
		assert.strictEqual(parsed?.column, 15);
		assert.strictEqual(parsed?.severity, 'error');
		assert.strictEqual(parsed?.message, 'invalid operands to binary expression');
		assert.ok(parsed?.range);
		assert.strictEqual(parsed?.range?.startLine, 47);
		assert.strictEqual(parsed?.range?.startColumn, 8);
		assert.strictEqual(parsed?.range?.endLine, 47);
		assert.strictEqual(parsed?.range?.endColumn, 14);
	});

	it('parses Clang remark', () => {
		const line = 'loop.cpp:10:1: remark: vectorized loop';
		const parsed = extractErrorLocation(line);
		assert.ok(parsed);
		assert.strictEqual(parsed?.file, 'loop.cpp');
		assert.strictEqual(parsed?.line, 10);
		assert.strictEqual(parsed?.column, 1);
		assert.strictEqual(parsed?.severity, 'remark');
		assert.strictEqual(parsed?.message, 'vectorized loop');
	});

	it('parses MSVC format', () => {
		const line = 'C:\\\\Users\\\\dev\\\\main.cpp(42,10): error: invalid syntax';
		const parsed = extractErrorLocation(line);
		assert.ok(parsed);
		assert.strictEqual(parsed?.file, 'C:\\\\Users\\\\dev\\\\main.cpp');
		assert.strictEqual(parsed?.line, 42);
		assert.strictEqual(parsed?.column, 10);
		assert.strictEqual(parsed?.severity, 'error');
		assert.strictEqual(parsed?.message, 'invalid syntax');
	});

	it('parses MSVC format without column', () => {
		const line = 'main.cpp(12): warning: something is off';
		const parsed = extractErrorLocation(line);
		assert.ok(parsed);
		assert.strictEqual(parsed?.file, 'main.cpp');
		assert.strictEqual(parsed?.line, 12);
		assert.strictEqual(parsed?.column, undefined);
		assert.strictEqual(parsed?.severity, 'warning');
	});

	it('parses vi format', () => {
		const line = 'main.cpp +12:34: error: invalid syntax';
		const parsed = extractErrorLocation(line);
		assert.ok(parsed);
		assert.strictEqual(parsed?.file, 'main.cpp');
		assert.strictEqual(parsed?.line, 12);
		assert.strictEqual(parsed?.column, 34);
		assert.strictEqual(parsed?.severity, 'error');
		assert.strictEqual(parsed?.message, 'invalid syntax');
	});
});
