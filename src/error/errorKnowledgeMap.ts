export interface KnowledgeMatch {
    tag: string;
    message: string;
}

interface PatternEntry {
    pattern: RegExp;
    tag: string;
    message: string;
}

const ERROR_PATTERNS: PatternEntry[] = [
    {
        // Catches most "missing semicolon" shapes:
        // expected ';' before 'return'
        // expected ';' at end of declaration
        // expected ';' after expression
        // expected initializer before ';' token
        pattern: /expected\s+['"`;]['"`]?\s+(before|after|at)|expected\s+\w+\s+before\s+['"`;]['"`]?\s*token/,
        tag: 'missing_semicolon',
        message: '可能缺少分号、右括号或语句结束符',
    },
    {
        pattern: /was not declared in this scope/,
        tag: 'undeclared_identifier',
        message: '使用了未声明的变量、函数或类型',
    },
    {
        pattern: /no matching function for call to/,
        tag: 'function_call_mismatch',
        message: '函数调用参数类型或数量不匹配',
    },
    {
        pattern: /cannot convert/,
        tag: 'type_conversion',
        message: '类型转换失败或不允许',
    },
    {
        pattern: /undefined reference to/,
        tag: 'undefined_reference',
        message: '链接时找不到函数或变量定义',
    },
    {
        pattern: /multiple definition of/,
        tag: 'multiple_definition',
        message: '同一个符号被重复定义',
    },
    {
        pattern: /invalid use of non-static member/,
        tag: 'non_static_member',
        message: '非静态成员使用方式错误',
    },
    {
        pattern: /is private within this context/,
        tag: 'private_access',
        message: '访问了类的私有成员',
    },
    {
        pattern: /segmentation fault|sigsegv|signal 11/i,
        tag: 'segmentation_fault',
        message: '运行时访问了非法内存',
    },
    {
        // Catch-all for other "expected X" syntax errors.
        pattern: /expected\s+['"`\w]+/,
        tag: 'syntax_punctuation',
        message: '标点符号或分隔符使用错误',
    },
    {
        pattern: /cannot find -l/,
        tag: 'missing_library',
        message: '找不到链接库',
    },
    {
        pattern: /no such file or directory/i,
        tag: 'missing_header',
        message: '找不到头文件或源文件',
    },
];

/**
 * Match an English g++ error message against known knowledge tags.
 */
export function matchErrorToKnowledge(message: string): KnowledgeMatch[] {
    const normalized = message.toLowerCase();
    const matches: KnowledgeMatch[] = [];

    for (const entry of ERROR_PATTERNS) {
        if (entry.pattern.test(normalized)) {
            matches.push({ tag: entry.tag, message: entry.message });
        }
    }

    return matches;
}
