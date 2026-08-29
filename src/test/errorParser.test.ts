import * as assert from 'assert';
import { describe, it } from 'mocha';
import {
	extractErrorLocation,
	extractFirstDiagnosticLine,
	normalizeCompileOutputSelection,
	parseCompilerStderr,
	parseCompilerStderrWithIncludes,
	type CompileSelectionRange,
} from '../error/errorParser';

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

	it('parses Clang fatal error without location', () => {
		const line = 'fatal error: \'missing.h\' file not found';
		const parsed = extractErrorLocation(line);
		assert.ok(parsed);
		assert.strictEqual(parsed?.severity, 'error');
		assert.strictEqual(parsed?.message, "'missing.h' file not found");
		assert.strictEqual(parsed?.file, undefined);
		assert.strictEqual(parsed?.line, undefined);
		assert.strictEqual(parsed?.column, undefined);
	});

	it('parses GCC fatal error with location', () => {
		const line = 'main.cpp:2:10: fatal error: myheader.h: No such file or directory';
		const parsed = extractErrorLocation(line);
		assert.ok(parsed);
		assert.strictEqual(parsed?.file, 'main.cpp');
		assert.strictEqual(parsed?.line, 2);
		assert.strictEqual(parsed?.column, 10);
		assert.strictEqual(parsed?.severity, 'error');
		assert.strictEqual(parsed?.message, 'myheader.h: No such file or directory');
	});

	it('still ignores driver-level fatal errors without file-not-found message', () => {
		const line = 'fatal error: no input files';
		const parsed = extractErrorLocation(line);
		assert.strictEqual(parsed, undefined);
	});

	it('extracts Clang fatal error line from multi-line selection', () => {
		const selection = [
			"fatal error: 'missing.h' file not found",
			'    1 | #include "missing.h"',
			'      |          ^',
		].join('\n');
		assert.strictEqual(
			extractFirstDiagnosticLine(selection),
			"fatal error: 'missing.h' file not found"
		);
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

	it('parses MSVC error line with diagnostic code (real MSVC form)', () => {
		const line = "main.cpp(12,5): error C2676: binary '++': 'std::list<int>' does not define this operator";
		const parsed = extractErrorLocation(line);
		assert.ok(parsed);
		assert.strictEqual(parsed?.file, 'main.cpp');
		assert.strictEqual(parsed?.line, 12);
		assert.strictEqual(parsed?.column, 5);
		assert.strictEqual(parsed?.severity, 'error');
		assert.strictEqual(parsed?.code, 'C2676');
		assert.strictEqual(parsed?.message, "binary '++': 'std::list<int>' does not define this operator");
	});

	it('parses MSVC warning line with diagnostic code', () => {
		const line = "main.cpp(8): warning C4244: 'initializing': conversion from 'double' to 'int', possible loss of data";
		const parsed = extractErrorLocation(line);
		assert.ok(parsed);
		assert.strictEqual(parsed?.file, 'main.cpp');
		assert.strictEqual(parsed?.line, 8);
		assert.strictEqual(parsed?.column, undefined);
		assert.strictEqual(parsed?.severity, 'warning');
		assert.strictEqual(parsed?.code, 'C4244');
		assert.strictEqual(parsed?.message, "'initializing': conversion from 'double' to 'int', possible loss of data");
	});

	it('parses MSVC fatal error line with code, severity normalized to error', () => {
		const line = "main.cpp(3): fatal error C1083: Cannot open include file: 'x.h': No such file or directory";
		const parsed = extractErrorLocation(line);
		assert.ok(parsed);
		assert.strictEqual(parsed?.file, 'main.cpp');
		assert.strictEqual(parsed?.line, 3);
		assert.strictEqual(parsed?.column, undefined);
		assert.strictEqual(parsed?.severity, 'error');
		assert.strictEqual(parsed?.code, 'C1083');
		assert.strictEqual(parsed?.message, "Cannot open include file: 'x.h': No such file or directory");
	});

	it('keeps code undefined for bare MSVC severity without code', () => {
		const line = 'C:\\\\Users\\\\dev\\\\main.cpp(42,10): error: invalid syntax';
		const parsed = extractErrorLocation(line);
		assert.ok(parsed);
		assert.strictEqual(parsed?.severity, 'error');
		assert.strictEqual(parsed?.code, undefined);
		assert.strictEqual(parsed?.message, 'invalid syntax');
	});

	it('parses MSVC linker line without line/column', () => {
		const line = 'main.obj : error LNK2019: unresolved external symbol "void __cdecl foo(void)" (?foo@@YAXXZ) referenced in function _main';
		const parsed = extractErrorLocation(line);
		assert.ok(parsed);
		assert.strictEqual(parsed?.file, 'main.obj');
		assert.strictEqual(parsed?.line, undefined);
		assert.strictEqual(parsed?.column, undefined);
		assert.strictEqual(parsed?.severity, 'error');
		assert.strictEqual(parsed?.code, 'LNK2019');
		assert.strictEqual(parsed?.message, 'unresolved external symbol "void __cdecl foo(void)" (?foo@@YAXXZ) referenced in function _main');
	});

	it('parses MSVC fatal linker line (LINK : fatal error LNK1104)', () => {
		const line = "LINK : fatal error LNK1104: cannot open file 'kernel32.lib'";
		const parsed = extractErrorLocation(line);
		assert.ok(parsed);
		assert.strictEqual(parsed?.file, 'LINK');
		assert.strictEqual(parsed?.severity, 'error');
		assert.strictEqual(parsed?.code, 'LNK1104');
		assert.strictEqual(parsed?.message, "cannot open file 'kernel32.lib'");
	});

	it('does not misparse GCC diagnostic lines via the MSVC code/linker patterns', () => {
		// GCC 路径回归锚:这些行此前走 severityMarkerPattern,放宽 MSVC 码位与
		// 新增链接器 pattern 后必须仍走原路径、字段语义不变。
		const gcc = extractErrorLocation("main.cpp:12:34: error: 'x' was not declared in this scope");
		assert.ok(gcc);
		assert.strictEqual(gcc?.file, 'main.cpp');
		assert.strictEqual(gcc?.code, undefined);
		assert.strictEqual(gcc?.message, "'x' was not declared in this scope");

		const gccFatal = extractErrorLocation('main.cpp:2:10: fatal error: xxx.h: No such file or directory');
		assert.ok(gccFatal);
		assert.strictEqual(gccFatal?.severity, 'error');
		assert.strictEqual(gccFatal?.file, 'main.cpp');
		assert.strictEqual(gccFatal?.message, 'xxx.h: No such file or directory');

		const gccBracket = extractErrorLocation("main.cpp:3:5: warning: unused variable 'x' [-Wunused-variable]");
		assert.ok(gccBracket);
		assert.strictEqual(gccBracket?.code, '-Wunused-variable');
		assert.strictEqual(gccBracket?.message, "unused variable 'x'");
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

	it('extracts first diagnostic line from multi-line selection', () => {
		const selection = [
			"c:\\Users\\14092\\Desktop\\智理杯\\test_directory\\test.cpp:19:24: error: expected ';' before 'return'",
			'   19 |     cout << ans << endl',
			'      |                        ^',
			'      |                        ;',
		].join('\n');

		const diagnosticLine = extractFirstDiagnosticLine(selection);
		assert.ok(diagnosticLine);
		assert.ok(diagnosticLine?.includes("expected ';' before 'return'"));

		const parsed = extractErrorLocation(diagnosticLine!);
		assert.ok(parsed);
		assert.strictEqual(parsed?.file, 'c:\\Users\\14092\\Desktop\\智理杯\\test_directory\\test.cpp');
		assert.strictEqual(parsed?.line, 19);
		assert.strictEqual(parsed?.column, 24);
		assert.strictEqual(parsed?.severity, 'error');
	});

	it('parses Windows backslash path with Chinese directory names', () => {
		const line = "c:\\Users\\14092\\Desktop\\智理杯\\test_directory\\test.cpp:19:24: error: expected ';' before 'return'";
		const parsed = extractErrorLocation(line);
		assert.ok(parsed);
		assert.strictEqual(parsed?.file, 'c:\\Users\\14092\\Desktop\\智理杯\\test_directory\\test.cpp');
		assert.strictEqual(parsed?.line, 19);
		assert.strictEqual(parsed?.column, 24);
		assert.strictEqual(parsed?.severity, 'error');
		assert.strictEqual(parsed?.message, "expected ';' before 'return'");
	});

	describe('normalizeCompileOutputSelection', () => {
		const makeRange = (
			startLine: number,
			startCharacter: number,
			endLine: number,
			endCharacter: number
		): CompileSelectionRange => ({
			startLine,
			startCharacter,
			endLine,
			endCharacter,
		});

		it('returns first error from complete multi-line block', () => {
			const fullOutput = [
				"main.cpp:5:10: error: expected ';' before 'return'",
				'    5 |     int x = 1',
				'      |          ^',
				'      |          ;',
			].join('\n');

			const result = normalizeCompileOutputSelection(fullOutput, fullOutput, makeRange(0, 0, 3, 12));
			assert.ok(result);
			assert.strictEqual(result?.primaryDiagnostic.file, 'main.cpp');
			assert.strictEqual(result?.primaryDiagnostic.line, 5);
			assert.strictEqual(result?.primaryDiagnostic.message, "expected ';' before 'return'");
			assert.strictEqual(result?.contextLines.length, 3);
			assert.ok(result?.displayText.includes("expected ';' before 'return'"));
			assert.ok(result?.displayText.includes('^'));
			assert.strictEqual(result?.expanded, false);
		});

		it('expands partial single-line selection using full output', () => {
			const fullOutput = "main.cpp:12:34: error: 'x' was not declared in this scope";
			const selectedText = "'x' was not declared";
			const range = makeRange(0, 27, 0, 47);

			const result = normalizeCompileOutputSelection(selectedText, fullOutput, range);
			assert.ok(result);
			assert.strictEqual(result?.primaryDiagnostic.file, 'main.cpp');
			assert.strictEqual(result?.primaryDiagnostic.line, 12);
			assert.strictEqual(result?.primaryDiagnostic.column, 34);
			assert.strictEqual(result?.primaryDiagnostic.message, "'x' was not declared in this scope");
			assert.strictEqual(result?.contextLines.length, 0);
			assert.strictEqual(result?.displayText, fullOutput);
			assert.strictEqual(result?.expanded, false);
		});

		it('recovers owning diagnostic from caret-only selection', () => {
			const fullOutput = [
				"main.cpp:5:10: error: expected ';' before 'return'",
				'    5 |     int x = 1',
				'      |          ^',
				'      |          ;',
			].join('\n');
			const selectedText = [
				'    5 |     int x = 1',
				'      |          ^',
				'      |          ;',
			].join('\n');

			const result = normalizeCompileOutputSelection(selectedText, fullOutput, makeRange(1, 0, 3, 12));
			assert.ok(result);
			assert.strictEqual(result?.primaryDiagnostic.message, "expected ';' before 'return'");
			assert.strictEqual(result?.contextLines.length, 3);
			assert.ok(result?.displayText.includes('error:'));
			assert.ok(result?.displayText.includes('^'));
			assert.strictEqual(result?.expanded, true);
		});

		it('handles multiple incomplete diagnostics and prefers error over warning', () => {
			const fullOutput = [
				"main.cpp:5:10: error: expected ';' before 'return'",
				'    5 |     int x = 1',
				'      |          ^',
				"main.cpp:8:5: warning: unused variable 'y' [-Wunused-variable]",
				'    8 |     int y;',
			].join('\n');
			const selectedText = [
				"pected ';' before 'return'",
				'    5 |     int x = 1',
				'      |          ^',
				'main.cpp:8:5: warning: unused',
			].join('\n');

			const result = normalizeCompileOutputSelection(selectedText, fullOutput, makeRange(0, 10, 3, 30));
			assert.ok(result);
			assert.strictEqual(result?.primaryDiagnostic.message, "expected ';' before 'return'");
			assert.strictEqual(result?.otherDiagnostics.length, 1);
			assert.strictEqual(result?.otherDiagnostics[0].message, "unused variable 'y'");
			assert.ok(result?.displayText.includes('Your selection also contains'));
		});

		it('returns undefined for non-diagnostic selection', () => {
			const fullOutput = [
				'Compiled: main.cpp',
				'Exit code: 0',
			].join('\n');
			const result = normalizeCompileOutputSelection('Compiled: main.cpp', fullOutput, makeRange(0, 0, 0, 18));
			assert.strictEqual(result, undefined);
		});

		it('does not expand beyond backward search limit', () => {
			const fullOutput = [
				"main.cpp:1:1: error: far away error",
				...Array.from({ length: 25 }, (_, i) => `line ${i + 2}: context`),
				'      |          ^',
			].join('\n');

			const result = normalizeCompileOutputSelection(
				'      |          ^',
				fullOutput,
				makeRange(26, 0, 26, 18)
			);
			assert.strictEqual(result, undefined);
		});

		it('preserves Windows Chinese path when expanding partial line', () => {
			const fullOutput = "c:\\Users\\14092\\Desktop\\智理杯\\test_directory\\test.cpp:19:24: error: expected ';' before 'return'";
			const selectedText = "expected ';' before 'return'";
			const range = makeRange(0, 64, 0, 91);

			const result = normalizeCompileOutputSelection(selectedText, fullOutput, range);
			assert.ok(result);
			assert.strictEqual(
				result?.primaryDiagnostic.file,
				'c:\\Users\\14092\\Desktop\\智理杯\\test_directory\\test.cpp'
			);
			assert.strictEqual(result?.primaryDiagnostic.line, 19);
			assert.strictEqual(result?.primaryDiagnostic.column, 24);
		});

		it('recovers first error when user selects a fragment of the source snippet line', () => {
			const fullOutput = [
				"c:\\Users\\14092\\Desktop\\智理杯\\test_directory\\test.cpp:13:16: error: 'a' was not declared in this scope",
				'   13 |         cin >> a[i];',
				'      |                ^',
				"c:\\Users\\14092\\Desktop\\智理杯\\test_directory\\test.cpp:16:27: error: expected primary-expression before ')' token",
				'   16 |     for(int i = 0;i < n;i+) {',
				'      |                           ^',
				"c:\\Users\\14092\\Desktop\\智理杯\\test_directory\\test.cpp:17:17: error: 'a' was not declared in this scope",
				'   17 |         ans += (a[i] >= m)',
				'      |                 ^',
			].join('\n');

			// User selects a fragment of the source snippet line belonging to the
			// first error. The selection contains no diagnostic line itself.
			const selectedText = 'cin >> a';
			const range = makeRange(1, 16, 1, 24);

			const result = normalizeCompileOutputSelection(selectedText, fullOutput, range);
			assert.ok(result);
			assert.strictEqual(result?.primaryDiagnostic.file, 'c:\\Users\\14092\\Desktop\\智理杯\\test_directory\\test.cpp');
			assert.strictEqual(result?.primaryDiagnostic.line, 13);
			assert.strictEqual(result?.primaryDiagnostic.column, 16);
			assert.strictEqual(result?.primaryDiagnostic.message, "'a' was not declared in this scope");
			assert.strictEqual(result?.expanded, true);
			assert.ok(result?.displayText.includes('cin >> a[i];'));
		});

		it('captures all three errors when selection starts and ends inside source snippet lines', () => {
			const fullOutput = [
				"c:\\Users\\14092\\Desktop\\智理杯\\test_directory\\test.cpp:13:16: error: 'a' was not declared in this scope",
				'   13 |         cin >> a[i];',
				'      |                ^',
				"c:\\Users\\14092\\Desktop\\智理杯\\test_directory\\test.cpp:16:27: error: expected primary-expression before ')' token",
				'   16 |     for(int i = 0;i < n;i+) {',
				'      |                           ^',
				"c:\\Users\\14092\\Desktop\\智理杯\\test_directory\\test.cpp:17:17: error: 'a' was not declared in this scope",
				'   17 |         ans += (a[i] >= m)',
				'      |                 ^',
			].join('\n');

			// User selection starts mid-way through the first source snippet line
			// (" >> a[i];") and ends mid-way through the last source snippet line
			// ("ans += (a["). The first diagnostic line is NOT in the selection,
			// but the two remaining diagnostic lines are fully present.
			const selectedText = [
				' >> a[i];',
				'      |                ^',
				"c:\\Users\\14092\\Desktop\\智理杯\\test_directory\\test.cpp:16:27: error: expected primary-expression before ')' token",
				'   16 |     for(int i = 0;i < n;i+) {',
				'      |                           ^',
				"c:\\Users\\14092\\Desktop\\智理杯\\test_directory\\test.cpp:17:17: error: 'a' was not declared in this scope",
				'   17 |         ans += (a[',
			].join('\n');

			const range = makeRange(1, 18, 7, 27);

			const result = normalizeCompileOutputSelection(selectedText, fullOutput, range);
			assert.ok(result);

			// Primary diagnostic must be the first error, recovered by expanding
			// the partial first line and then searching backwards.
			assert.strictEqual(result?.primaryDiagnostic.file, 'c:\\Users\\14092\\Desktop\\智理杯\\test_directory\\test.cpp');
			assert.strictEqual(result?.primaryDiagnostic.line, 13);
			assert.strictEqual(result?.primaryDiagnostic.column, 16);
			assert.strictEqual(result?.primaryDiagnostic.message, "'a' was not declared in this scope");

			// The other two errors inside the selection must also be captured.
			assert.strictEqual(result?.otherDiagnostics.length, 2);
			const otherLines = result?.otherDiagnostics.map((d) => d.line).sort((a, b) => (a ?? 0) - (b ?? 0));
			assert.deepStrictEqual(otherLines, [16, 17]);

			assert.strictEqual(result?.expanded, true);
			assert.ok(result?.displayText.includes('cin >> a[i];'));
			assert.ok(result?.displayText.includes('for(int i = 0;i < n;i+) {'));
			assert.ok(result?.displayText.includes('ans += (a[i] >= m)'));
		});
	});
	describe('parseCompilerStderrWithIncludes (include 栈归因)', () => {
		const SINGLE_LEVEL_STDERR = [
			'In file included from a.cpp:1:',
			"b.h:5:10: error: expected ';' before '}' token",
			'   5 | struct Card {',
			'     |              ^',
			"a.cpp:7:1: error: 'x' was not declared in this scope",
		].join('\n');

		it('头文件错误归属最深处的头文件,并保留 include 链元数据', () => {
			const parsed = parseCompilerStderrWithIncludes(SINGLE_LEVEL_STDERR);
			const headerError = parsed.find((e) => e.severity === 'error' && e.file?.endsWith('b.h'));
			assert.ok(headerError, '应解析出 b.h 的错误');
			assert.strictEqual(headerError.file, 'b.h');
			assert.strictEqual(headerError.line, 5);
			assert.deepStrictEqual(headerError.viaIncludes, ['a.cpp:1']);

			// 主翻译单元自己的错误不带链路,且清掉旧栈。
			const mainError = parsed.find((e) => e.file === 'a.cpp' && e.severity === 'error');
			assert.ok(mainError);
			assert.strictEqual(mainError.viaIncludes, undefined);
		});

		it('同一栈下的多条头文件诊断都携带链路;新栈重置旧栈', () => {
			const stderr = [
				'In file included from a.cpp:1:',
				"b.h:5:10: error: expected ';' before '}' token",
				"b.h:9:3: error: 'y' was not declared in this scope",
				'In file included from other.cpp:3:',
				"c.h:2:8: warning: unused variable 'z'",
				'b.h:12:5: error: stale should follow the nearest stack',
			].join('\n');
			const parsed = parseCompilerStderrWithIncludes(stderr);

			const bErrors = parsed.filter((e) => e.severity === 'error' && e.file === 'b.h');
			assert.strictEqual(bErrors.length, 3);
			assert.deepStrictEqual(bErrors[0].viaIncludes, ['a.cpp:1']);
			assert.deepStrictEqual(bErrors[1].viaIncludes, ['a.cpp:1']);
			const cWarning = parsed.find((e) => e.severity === 'warning');
			assert.ok(cWarning);
			assert.deepStrictEqual(cWarning.viaIncludes, ['other.cpp:3']);
			// "In file included from" 重置旧栈:后续诊断跟随最近的栈。
			assert.deepStrictEqual(bErrors[2].viaIncludes, ['other.cpp:3']);
		});

		it('多层嵌套 include(缩进 from 续行)按从内到外记录', () => {
			const stderr = [
				'In file included from c.h:2,',
				'                 from b.h:6,',
				'                 from a.cpp:1:',
				"x.h:3:10: error: 'Card' does not name a type",
			].join('\n');
			const parsed = parseCompilerStderrWithIncludes(stderr);
			const error = parsed.find((e) => e.severity === 'error');
			assert.ok(error);
			assert.strictEqual(error.file, 'x.h');
			assert.deepStrictEqual(error.viaIncludes, ['c.h:2', 'b.h:6', 'a.cpp:1']);
		});

		it('与 parseCompilerStderr 的条目集合一致(只增不改既有语义)', () => {
			assert.deepStrictEqual(
				parseCompilerStderrWithIncludes(SINGLE_LEVEL_STDERR).map((e) => [e.file, e.line, e.message]),
				parseCompilerStderr(SINGLE_LEVEL_STDERR).map((e) => [e.file, e.line, e.message])
			);
		});
	});
});
