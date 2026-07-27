import * as assert from 'assert';
import { describe, it } from 'mocha';
import { buildCompileArgs } from '../compiler/compilerService';

describe('multi-file compiler arguments', () => {
    it('passes every implementation file to g++', () => {
        const args = buildCompileArgs(['main.cpp', 'student.cpp'], 'homework.exe');
        assert.deepStrictEqual(args, [
            '-std=c++17', '-O2', '-Wall', 'main.cpp', 'student.cpp', '-o', 'homework.exe',
        ]);
    });
});
