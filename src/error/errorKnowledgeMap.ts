export interface KnowledgeMatch {
    tag: string;
    message: string;
}

export interface KnowledgeConcept {
    tag: string;
    title: string;
    summary: string;
    commonCauses: string[];
    suggestedFixes: string[];
    checkMethod: string;
    wrongExample: string;
    correctExample: string;
    relatedTags?: string[];
}

export interface PatternEntry {
    pattern: RegExp;
    tag: string;
    message: string;
    concept?: KnowledgeConcept;
}

const CONCEPTS: Record<string, KnowledgeConcept> = {
    missing_semicolon: {
        tag: 'missing_semicolon',
        title: '缺少分号或语句结束符',
        summary: 'C++ 中每条语句通常以分号结束；如果漏写，编译器会报 "expected ; before ..." 之类的错误。',
        commonCauses: [
            '普通语句末尾漏写分号',
            'for / while / if 的圆括号后误加分号导致语句体为空',
            '类或结构体定义末尾漏写分号',
        ],
        suggestedFixes: [
            '在报错行或上一行末尾补充分号',
            '检查 for(;;) 结构里的两个分号是否都在',
            '类/结构体定义结束的大括号后添加分号',
        ],
        checkMethod: '重新编译，若 "expected ;" 消失即说明已修复。',
        wrongExample: "int main() {\n    int x = 1\n    return 0;\n}",
        correctExample: "int main() {\n    int x = 1;\n    return 0;\n}",
    },
    undeclared_identifier: {
        tag: 'undeclared_identifier',
        title: '变量/函数未声明',
        summary: '代码中使用了编译器尚未见过的标识符，可能是拼写错误、缺少头文件或变量未定义。',
        commonCauses: [
            '标识符拼写错误（大小写、额外字符）',
            '变量或函数在使用后才定义，且未前置声明',
            '缺少必要的头文件或命名空间前缀',
        ],
        suggestedFixes: [
            '检查并修正标识符拼写',
            '确保变量在使用前已声明或定义',
            '包含缺失的头文件，或使用 std:: 等完整限定名',
        ],
        checkMethod: '重新编译；若提示消失，说明已声明成功。',
        wrongExample: "int main() {\n    x = 1;\n    return 0;\n}",
        correctExample: "int main() {\n    int x = 1;\n    return 0;\n}",
    },
    function_call_mismatch: {
        tag: 'function_call_mismatch',
        title: '函数调用参数不匹配',
        summary: '调用函数时传入的参数类型或数量与函数声明不一致。',
        commonCauses: [
            '参数个数写多或写少',
            '参数类型无法隐式转换（如把字符串传给 int 形参）',
            '函数重载匹配失败',
        ],
        suggestedFixes: [
            '对照函数声明检查参数个数和顺序',
            '确保每个参数的类型与声明一致，必要时显式转换',
            '检查是否遗漏了需要的重载版本',
        ],
        checkMethod: '重新编译，确认 "no matching function" 报错消失。',
        wrongExample: "void foo(int a) {}\nint main() {\n    foo(1, 2);\n    return 0;\n}",
        correctExample: "void foo(int a) {}\nint main() {\n    foo(1);\n    return 0;\n}",
    },
    type_conversion: {
        tag: 'type_conversion',
        title: '类型转换失败',
        summary: '把某个类型的值赋给不兼容的类型，或进行了不被允许的隐式/显式转换。',
        commonCauses: [
            '把 const 对象赋给非 const 指针',
            '不同类型指针之间直接赋值',
            '自定义类型之间没有合适的转换构造函数或运算符',
        ],
        suggestedFixes: [
            '检查赋值两边的类型是否一致',
            '必要时使用 static_cast、dynamic_cast 等显式转换',
            '若需要转换，补充转换构造函数或类型转换运算符',
        ],
        checkMethod: '重新编译，确认 "cannot convert" 报错消失。',
        wrongExample: "int main() {\n    int* p = &1;\n    return 0;\n}",
        correctExample: "int main() {\n    int x = 1;\n    int* p = &x;\n    return 0;\n}",
    },
    undefined_reference: {
        tag: 'undefined_reference',
        title: '链接错误：未定义引用',
        summary: '编译阶段通过，但链接器找不到某个函数或变量的定义，通常是因为漏写了实现或没链接库。',
        commonCauses: [
            '只声明了函数/变量，却没有实现',
            '多文件项目里漏链接了包含实现的 .cpp 文件',
            '使用了外部库但没有加 -l 链接选项',
        ],
        suggestedFixes: [
            '为声明的函数/变量补充实现',
            '在 g++ 命令中包含所有需要的 .cpp 文件',
            '检查是否需要 -lxxx 或 -L/path 链接库',
        ],
        checkMethod: '重新编译并链接，确认 "undefined reference" 消失。',
        wrongExample: "void foo();\nint main() {\n    foo();\n    return 0;\n}",
        correctExample: "void foo() {}\nint main() {\n    foo();\n    return 0;\n}",
    },
    multiple_definition: {
        tag: 'multiple_definition',
        title: '符号重复定义',
        summary: '同一个函数或变量在多处被定义，链接器无法决定使用哪一个。',
        commonCauses: [
            '在头文件中定义了全局变量或函数，并被多个 .cpp 包含',
            '同名的函数/变量在不同 .cpp 中各写了一遍',
            '复制代码时忘了改名',
        ],
        suggestedFixes: [
            '头文件里只声明，定义放到单个 .cpp 中',
            '对需要在头文件定义的内容使用 inline 或 static',
            '检查同名符号并统一命名',
        ],
        checkMethod: '重新编译链接，确认 "multiple definition" 消失。',
        wrongExample: "// a.cpp\nint x = 1;\n// b.cpp\nint x = 1;",
        correctExample: "// a.cpp\nint x = 1;\n// b.cpp\nextern int x;",
    },
    non_static_member: {
        tag: 'non_static_member',
        title: '非静态成员使用错误',
        summary: '类的非静态成员必须通过对象实例访问，不能直接用类名调用。',
        commonCauses: [
            '用类名而不是对象名调用普通成员变量/函数',
            '静态成员函数中错误地访问了非静态成员',
            '混淆了 static 和普通成员的区别',
        ],
        suggestedFixes: [
            '创建类的实例，通过实例访问成员',
            '若确实不依赖实例状态，将成员改为 static',
            '静态函数中只访问静态成员',
        ],
        checkMethod: '重新编译，确认 invalid use of non-static member 报错消失。',
        wrongExample: "class A {\npublic:\n    int x;\n};\nint main() {\n    A::x = 1;\n    return 0;\n}",
        correctExample: "class A {\npublic:\n    int x;\n};\nint main() {\n    A a;\n    a.x = 1;\n    return 0;\n}",
    },
    private_access: {
        tag: 'private_access',
        title: '访问了类的私有成员',
        summary: 'C++ 的 private 成员只能在类内部访问，类外部直接访问会触发权限错误。',
        commonCauses: [
            '在类外部读取或修改 private 成员',
            '应该在 public 中提供 getter/setter',
            '派生类中访问了基类的 private 成员',
        ],
        suggestedFixes: [
            '通过 public 的 getter/setter 访问私有成员',
            '把需要外部访问的成员改为 public',
            '若需要在派生类中使用，改为 protected',
        ],
        checkMethod: '重新编译，确认 is private 报错消失。',
        wrongExample: "class A {\n    int x;\n};\nint main() {\n    A a;\n    a.x = 1;\n    return 0;\n}",
        correctExample: "class A {\npublic:\n    int x;\n};\nint main() {\n    A a;\n    a.x = 1;\n    return 0;\n}",
    },
    segmentation_fault: {
        tag: 'segmentation_fault',
        title: '运行时段错误（非法内存访问）',
        summary: '程序运行时访问了未分配或无权访问的内存地址，常见于指针、数组越界或空指针解引用。',
        commonCauses: [
            '使用了未初始化的指针',
            '数组下标越界',
            '访问已经释放的内存（use-after-free）',
        ],
        suggestedFixes: [
            '指针使用前初始化或 new/malloc 分配',
            '检查数组下标是否在合法范围内',
            '避免重复释放同一块内存',
        ],
        checkMethod: '修复后重新编译运行，观察是否还出现 Segmentation fault。',
        wrongExample: "int main() {\n    int* p;\n    *p = 1;\n    return 0;\n}",
        correctExample: "int main() {\n    int x = 0;\n    int* p = &x;\n    *p = 1;\n    return 0;\n}",
    },
    syntax_punctuation: {
        tag: 'syntax_punctuation',
        title: '标点符号或分隔符语法错误',
        summary: '代码中存在括号、引号、逗号等标点符号不匹配或位置错误。',
        commonCauses: [
            '括号、引号没有成对出现',
            '逗号、冒号等分隔符位置不对',
            '宏展开后产生意外符号',
        ],
        suggestedFixes: [
            '仔细检查报错位置附近的括号/引号匹配',
            '使用编辑器的括号高亮功能',
            '简化复杂宏或表达式，逐步定位',
        ],
        checkMethod: '重新编译，确认 expected ... 类报错消失。',
        wrongExample: "int main() {\n    if (true {\n        return 0;\n    }\n}",
        correctExample: "int main() {\n    if (true) {\n        return 0;\n    }\n}",
    },
    missing_library: {
        tag: 'missing_library',
        title: '找不到链接库',
        summary: '编译命令中指定了需要链接的库，但链接器找不到对应的库文件。',
        commonCauses: [
            '库名写错或大小写不对',
            '库文件不在默认搜索路径中',
            '没有安装对应的开发包',
        ],
        suggestedFixes: [
            '确认库名正确（如 -lws2_32）',
            '使用 -L/path 指定库文件所在目录',
            '安装缺失的开发库',
        ],
        checkMethod: '重新编译链接，确认 cannot find -lxxx 报错消失。',
        wrongExample: "g++ main.cpp -lnotexist",
        correctExample: "g++ main.cpp -lws2_32",
    },
    missing_header: {
        tag: 'missing_header',
        title: '找不到头文件或源文件',
        summary: '#include 的文件或命令行指定的源文件路径不存在或无法访问。',
        commonCauses: [
            '文件名拼写错误或大小写不匹配',
            '文件不在编译命令的搜索路径中',
            '使用尖括号包含了自己项目的本地头文件',
        ],
        suggestedFixes: [
            '核对文件名和路径拼写',
            '对本地头文件使用 #include \"xxx.h\"',
            '用 -I/path 添加头文件搜索目录',
        ],
        checkMethod: '重新编译，确认 no such file or directory 报错消失。',
        wrongExample: "#include <myheader.h>\nint main() { return 0; }",
        correctExample: "#include \"myheader.h\"\nint main() { return 0; }",
    },
    make_no_rule: {
        tag: 'make_no_rule',
        title: 'make 找不到构建规则',
        summary: 'make 报 "No rule to make target"，说明 Makefile 里没有能生成某个目标的规则，常见于目标名拼写不一致或规则缺失。',
        commonCauses: [
            'Makefile 里目标名与源文件名拼写不一致',
            '缺少从源文件生成目标文件的规则（如 .cpp → .o）',
            '依赖的文件被删除或改名后规则没有更新',
        ],
        suggestedFixes: [
            '核对报错中目标名的拼写与 Makefile 里的规则名是否一致',
            '为缺失的目标补充规则（可使用 %.o: %.cpp 模式规则）',
            '确认依赖的源文件/头文件真实存在于对应路径',
        ],
        checkMethod: '重新运行 make，确认 "No rule to make target" 消失。',
        wrongExample: "app: main.o\n\tg++ main.o -o app\n# 缺少 main.o 的生成规则",
        correctExample: "app: main.o\n\tg++ main.o -o app\nmain.o: main.cpp\n\tg++ -c main.cpp -o main.o",
    },
    operator_operand_mismatch: {
        tag: 'operator_operand_mismatch',
        title: '运算符操作数类型不匹配',
        summary: '运算符两边的操作数类型不支持该运算，编译器找不到可用的重载版本。',
        commonCauses: [
            '把 << 当作字符串拼接使用（如 int << 字符串）',
            '对不同类型的值使用算术或比较运算符',
            '自定义类型没有定义对应的运算符重载',
        ],
        suggestedFixes: [
            '检查运算符两边操作数的类型是否支持该运算',
            '字符串拼接应使用 std::string 或 std::to_string',
            '对自定义类型补充相应的 operator 重载',
        ],
        checkMethod: '重新编译，确认 "invalid operands" 或 "no match for operator" 报错消失。',
        wrongExample: "#include <string>\nint main() {\n    int x = 1;\n    std::string label = x << \"岁\";\n    return 0;\n}",
        correctExample: "#include <string>\nint main() {\n    int x = 1;\n    std::string label = std::to_string(x) + \"岁\";\n    return 0;\n}",
    },
    lvalue_required: {
        tag: 'lvalue_required',
        title: '赋值号左边必须是可修改的左值',
        summary: '赋值（=）的左侧必须是一个可寻址、可修改的对象（左值），表达式或字面量不能被赋值。',
        commonCauses: [
            '把赋值写在表达式右边一侧，如 a + b = c',
            '给函数调用的返回值赋值',
            '混淆了 == 和 =',
        ],
        suggestedFixes: [
            '检查赋值方向：被赋值的变量应写在 = 左边',
            '确认不是想写 == 比较',
            '若要保存结果，先定义变量再接收',
        ],
        checkMethod: '重新编译，确认 "lvalue required" 报错消失。',
        wrongExample: "int main() {\n    int a = 1, b = 2, c = 3;\n    a + b = c;\n    return 0;\n}",
        correctExample: "int main() {\n    int a = 1, b = 2, c = 3;\n    c = a + b;\n    return 0;\n}",
    },
    array_out_of_bounds: {
        tag: 'array_out_of_bounds',
        title: '数组下标越界',
        summary: '访问数组时使用的下标超出了数组声明的合法范围。',
        commonCauses: [
            '下标从 0 开始却按 1 开始使用（访问了 a[n]）',
            '循环边界写成了 <= 而不是 <',
            '用未初始化或错误的变量做下标',
        ],
        suggestedFixes: [
            '记住数组有效下标是 0 到 n-1',
            '检查循环条件是否应为 i < n',
            '打印或断言下标值，确认其在合法范围内',
        ],
        checkMethod: '重新编译，确认 "array subscript out of bounds"/"subscript out of range" 报错消失。',
        wrongExample: "int main() {\n    int a[5] = {0};\n    for (int i = 0; i <= 5; i++) {\n        a[i] = i;\n    }\n    return 0;\n}",
        correctExample: "int main() {\n    int a[5] = {0};\n    for (int i = 0; i < 5; i++) {\n        a[i] = i;\n    }\n    return 0;\n}",
    },
    overload_ambiguous: {
        tag: 'overload_ambiguous',
        title: '重载调用歧义',
        summary: '多个重载版本都能匹配这次调用，或者实参个数/类型与任何候选都不完全一致，编译器无法做出唯一选择。',
        commonCauses: [
            '实参类型需要隐式转换，多个重载都“差不多能行”',
            '调用时实参个数与所有重载版本都对不上',
            '重载版本之间参数列表过于相似',
        ],
        suggestedFixes: [
            '对照各候选版本的参数列表，检查实参个数和类型',
            '必要时做显式类型转换，让某个重载成为唯一最优匹配',
            '合并或删除过于相似的重载版本',
        ],
        checkMethod: '重新编译，确认 "is ambiguous"/"candidate expects" 报错消失。',
        wrongExample: "void f(int a) {}\nvoid f(double a) {}\nint main() {\n    f(1L);\n    return 0;\n}",
        correctExample: "void f(int a) {}\nvoid f(double a) {}\nint main() {\n    f(1);\n    return 0;\n}",
    },
    control_flow_return: {
        tag: 'control_flow_return',
        title: '非 void 函数缺少返回值',
        summary: '返回类型不是 void 的函数，存在某条执行路径没有 return 一个值，属于未定义行为风险。',
        commonCauses: [
            '函数末尾忘记写 return',
            'if / 分支中只在部分路径写了 return',
            '循环内 return 后误以为循环外也需要处理',
        ],
        suggestedFixes: [
            '检查每条分支是否都有明确的 return 值',
            '在函数末尾补上默认的 return',
            '若确实不需要返回值，将返回类型改为 void',
        ],
        checkMethod: '重新编译，确认 "control reaches end of non-void function" 报错消失。',
        wrongExample: "int max(int a, int b) {\n    if (a > b) {\n        return a;\n    }\n}",
        correctExample: "int max(int a, int b) {\n    if (a > b) {\n        return a;\n    }\n    return b;\n}",
    },
    pointer_dereference_mismatch: {
        tag: 'pointer_dereference_mismatch',
        title: '指针解引用方式错误（. 与 -> 混淆）',
        summary: '对象指针要用 -> 访问成员，普通对象要用 .；合法指针、数组以及支持 operator[] 的类型都可以使用 []，对不支持相应成员或下标运算的类型使用 -> 或 [] 会报错。',
        commonCauses: [
            '对结构体/类指针使用了 . 而不是 ->',
            '对普通对象使用了 ->',
            '对不支持下标运算的类型使用 []',
        ],
        suggestedFixes: [
            '指针访问成员统一使用 ->',
            '普通对象访问成员使用 .',
            '使用 [] 前确认该类型支持下标运算',
        ],
        checkMethod: '重新编译，确认 "base operand of \'->\'"/"request for member" 报错消失。',
        wrongExample: "struct S { int x; };\nint main() {\n    S s;\n    s->x = 1;\n    return 0;\n}",
        correctExample: "struct S { int x; };\nint main() {\n    S s;\n    s.x = 1;\n    return 0;\n}",
    },
    make_missing_separator: {
        tag: 'make_missing_separator',
        title: 'Makefile 命令行缺少 Tab 缩进',
        summary: 'make 报 "missing separator"，绝大多数情况是规则下的命令行用了空格而不是 Tab 开头。',
        commonCauses: [
            '规则下的命令行用空格缩进而非 Tab',
            '从网页或文档复制 Makefile 时 Tab 被替换成了空格',
            '在规则之外写了 make 无法识别的内容',
        ],
        suggestedFixes: [
            '把报错行行首的空格替换为一个 Tab',
            '开启编辑器“显示空白字符”确认行首是 Tab',
            '检查报错行附近是否有误写的文字',
        ],
        checkMethod: '重新运行 make，确认 "missing separator" 消失。',
        wrongExample: "app:\n    g++ main.cpp -o app\n# 行首是空格，make 无法识别",
        correctExample: "app:\n\tg++ main.cpp -o app\n# 行首是一个 Tab",
    },

    // ===== P5b 模板/STL 场景专属概念(经 templateKnowledgeSignatures 签名表匹配,
    // 不走 ERROR_PATTERNS 单消息匹配;语料 tmp-template-error-research/) =====

    iterator_category_mismatch: {
        tag: 'iterator_category_mismatch',
        title: '迭代器类别不满足算法要求',
        summary: 'std::sort 这类算法要求随机访问迭代器（能 it+n、it1-it2 直接跳步）；std::list 的迭代器是双向的，跳不了步，所以编译器解包进 sort 内部报 no match for \'operator-\'。报错落在 STL 源码里，根因却是你的调用——报错行不是你写错的那一行。',
        commonCauses: [
            '用 std::list 的迭代器调用 std::sort（list 是双向迭代器，不支持随机访问）',
            '把 set/map 的迭代器传给要求随机访问的算法',
        ],
        suggestedFixes: [
            'list 自带成员函数 lst.sort()，用它排序',
            '把数据换成 std::vector / std::deque 后再用 std::sort',
            'C++20 可用 std::ranges::sort，不满足约束时直接报在调用处，更好懂',
        ],
        checkMethod: '换成 vector（或改用 lst.sort()）后重新编译，报错消失即修复。',
        wrongExample: "#include <algorithm>\n#include <list>\nint main() {\n    std::list<int> lst{3, 1, 2};\n    std::sort(lst.begin(), lst.end());\n}",
        correctExample: "#include <list>\nint main() {\n    std::list<int> lst{3, 1, 2};\n    lst.sort();          // 或改用 std::vector 再 std::sort\n}",
        relatedTags: ['operator_operand_mismatch'],
    },
    comparator_not_defined: {
        tag: 'comparator_not_defined',
        title: '自定义类型缺少比较函数 operator<',
        summary: '把自定义类型放进 std::set/std::map，或用默认方式 std::sort 排序时，容器/算法要用 operator< 比较元素；类型没定义它，编译器会在 STL 深处报 no match for call to \'(std::less...)\' 或 no match for \'operator<\'，并且输出长达上千行。',
        commonCauses: [
            '自定义 struct/class 没有定义 operator<',
            '想按自定义规则比较，但没有把比较器传给 sort/set/map',
        ],
        suggestedFixes: [
            '给类型定义 bool operator<(const T& other) const',
            '或给 std::sort 传第三个参数（lambda 比较器），给 set/map 传第二个模板参数',
        ],
        checkMethod: '补上 operator< 或比较器后重新编译。',
        wrongExample: "struct Point { int x, y; };\n#include <set>\nint main() {\n    std::set<Point> s;\n    s.insert({1, 2});   // Point 没有 operator<\n}",
        correctExample: "#include <set>\nstruct Point {\n    int x, y;\n    bool operator<(const Point& o) const {\n        return x != o.x ? x < o.x : y < o.y;\n    }\n};\nint main() {\n    std::set<Point> s;\n    s.insert({1, 2});\n}",
        relatedTags: ['operator_operand_mismatch'],
    },
    map_value_type_const: {
        tag: 'map_value_type_const',
        title: 'map 的键带 const（元素是 pair<const K, V>）',
        summary: 'std::map 的元素类型是 std::pair<const Key, Value>——键带 const，防止你绕过 map 的排序约束直接改键。遍历/transform 时若把元素收成 pair<K, V>&（非 const、键不带 const），引用绑不上，报错解包进 STL 内部。',
        commonCauses: [
            'transform/for_each 的 lambda 形参写成 std::pair<K, V>&（少了 const）',
            '以为 map 的 value_type 是 pair<K, V>，忘了键是 const 的',
        ],
        suggestedFixes: [
            'lambda 形参改成 const std::pair<const K, V>&',
            '或按值接收（auto p / std::pair<const K, V> p）',
            'C++17 可用结构化绑定：for (const auto& [key, value] : m)',
        ],
        checkMethod: '修改 lambda/形参的类型后重新编译。',
        wrongExample: "#include <map>\n#include <algorithm>\nint main() {\n    std::map<std::string, int> m{{\"a\", 1}};\n    for_each(m.begin(), m.end(),\n        [](std::pair<std::string, int>& p) { (void)p; });\n}",
        correctExample: "#include <map>\n#include <algorithm>\nint main() {\n    std::map<std::string, int> m{{\"a\", 1}};\n    for_each(m.begin(), m.end(),\n        [](const std::pair<const std::string, int>& p) { (void)p; });\n}",
        relatedTags: ['type_conversion'],
    },
    stream_output_operator: {
        tag: 'stream_output_operator',
        title: '自定义类型没有流输出运算符 operator<<',
        summary: 'oss << obj 能编译的前提是存在 operator<<(std::ostream&, const T&)。自定义类型没定义它时，编译器会展开 ostream 的几十个候选重载（报错动辄三百行），但结论只是"找不到能输出你这个类型的重载"。',
        commonCauses: [
            '自定义 struct/class 没有写 operator<<',
            '把 operator<< 写成了成员函数——它通常应是自由函数或友元',
        ],
        suggestedFixes: [
            '定义 friend std::ostream& operator<<(std::ostream& os, const T& obj)',
            '函数末尾 return os; 以支持链式输出',
        ],
        checkMethod: '补上 operator<< 后重新编译，候选列表报错消失。',
        wrongExample: "#include <sstream>\nstruct Student { std::string name; };\nint main() {\n    std::ostringstream oss;\n    oss << Student{\"Tom\"};   // 没有 operator<<\n}",
        correctExample: "#include <sstream>\nstruct Student {\n    std::string name;\n    friend std::ostream& operator<<(std::ostream& os, const Student& s) {\n        return os << s.name;\n    }\n};\nint main() {\n    std::ostringstream oss;\n    oss << Student{\"Tom\"};\n}",
        relatedTags: ['operator_operand_mismatch'],
    },
    dependent_name_typename: {
        tag: 'dependent_name_typename',
        title: '依赖模板参数的类型名需要 typename 前缀',
        summary: '在模板里写 T::iterator 这类依赖模板参数的名字时，C++ 默认把它当"值"解析；它其实是类型时必须显式写 typename，否则报 need \'typename\' before ...。这类错误本来就报在你的代码行，不需要看 STL。',
        commonCauses: [
            '模板函数/模板类里直接把 T::xxx 当类型用',
        ],
        suggestedFixes: [
            '在依赖名前加 typename：typename T::iterator it;',
        ],
        checkMethod: '补上 typename 后重新编译。',
        wrongExample: "template<class T>\nvoid f() {\n    T::iterator it;   // 编译器不知它是类型还是值\n}",
        correctExample: "template<class T>\nvoid f() {\n    typename T::iterator it;\n}",
    },
    vector_bool_proxy: {
        tag: 'vector_bool_proxy',
        title: 'vector<bool> 是位压缩特化，元素访问返回代理对象',
        summary: 'vector<bool> 为了省空间按位存储，operator[]/解引用返回的是代理对象（_Bit_reference），不是真正的 bool&。所以 auto& 绑不上它、也不能对它取地址。它的行为和其它 vector 不同，初学者建议别和一般容器混着学。',
        commonCauses: [
            'for (auto& b : vectorBool) 试图用引用遍历并修改元素',
            '把 vector<bool>::reference 当 bool& 传给函数',
        ],
        suggestedFixes: [
            '遍历用 auto&& 或值拷贝 auto b = ...',
            '需要真正的 bool 引用就换 std::vector<char> / std::deque<bool> / std::bitset',
        ],
        checkMethod: '改成 auto&& 或值拷贝后重新编译。',
        wrongExample: "#include <vector>\nint main() {\n    std::vector<bool> flags{true, false};\n    for (auto& b : flags) {   // auto& 绑不上代理对象\n        b = !b;\n    }\n}",
        correctExample: "#include <vector>\nint main() {\n    std::vector<bool> flags{true, false};\n    for (auto&& b : flags) {  // 或 auto b\n        b = !b;\n    }\n}",
        relatedTags: ['type_conversion'],
    },
};

const ERROR_PATTERNS: PatternEntry[] = [
    {
        // MSVC C2143: syntax error: missing ';' before 'x'
        pattern: /expected\s+['\"`;]?['\"`]?;['\"`]?\s+(before|after|at)|expected\s+\w+\s+before\s+['\"`]?;['\"`]?\s*token|missing\s+['\"`;]?;['\"`]?\s+before/,
        tag: 'missing_semicolon',
        message: '可能缺少分号、右括号或语句结束符',
        concept: CONCEPTS.missing_semicolon,
    },
    {
        // MSVC C2065: 'x': undeclared identifier
        pattern: /was not declared in this scope|use of undeclared identifier|undeclared identifier/,
        tag: 'undeclared_identifier',
        message: '使用了未声明的变量、函数或类型',
        concept: CONCEPTS.undeclared_identifier,
    },
    {
        pattern: /no matching function for call to/,
        tag: 'function_call_mismatch',
        message: '函数调用参数类型或数量不匹配',
        concept: CONCEPTS.function_call_mismatch,
    },
    {
        // MSVC C4244/C4305: conversion from 'x' to 'y', possible loss of data
        pattern: /cannot convert|invalid conversion|narrowing conversion|possible loss of data/,
        tag: 'type_conversion',
        message: '类型转换失败或不允许',
        concept: CONCEPTS.type_conversion,
    },
    {
        pattern: /undefined reference to|unresolved external symbol/,
        tag: 'undefined_reference',
        message: '链接时找不到函数或变量定义',
        concept: CONCEPTS.undefined_reference,
    },
    {
        // MSVC LNK2005: symbol already defined in object
        pattern: /multiple definition of|already defined in/,
        tag: 'multiple_definition',
        message: '同一个符号被重复定义',
        concept: CONCEPTS.multiple_definition,
    },
    {
        pattern: /invalid use of non-static member/,
        tag: 'non_static_member',
        message: '非静态成员使用方式错误',
        concept: CONCEPTS.non_static_member,
    },
    {
        pattern: /is private within this context/,
        tag: 'private_access',
        message: '访问了类的私有成员',
        concept: CONCEPTS.private_access,
    },
    {
        pattern: /segmentation fault|sigsegv|signal 11/i,
        tag: 'segmentation_fault',
        message: '运行时访问了非法内存',
        concept: CONCEPTS.segmentation_fault,
    },
    {
        pattern: /expected\s+['\"`\w]+/,
        tag: 'syntax_punctuation',
        message: '标点符号或分隔符使用错误',
        concept: CONCEPTS.syntax_punctuation,
    },
    {
        // MSVC LNK1104: cannot open file 'xxx.lib'
        pattern: /cannot find -l|cannot open file.*\.lib/,
        tag: 'missing_library',
        message: '找不到链接库',
        concept: CONCEPTS.missing_library,
    },
    {
        // MSVC C1083 变体: Cannot open include file/source file 'xxx': No such file or directory;
        // Clang 无定位形态: fatal error: 'xxx' file not found (P2)
        pattern: /no such file or directory|cannot open include file|cannot open source file|'[^']*'\s+file not found/i,
        tag: 'missing_header',
        message: '找不到头文件或源文件',
        concept: CONCEPTS.missing_header,
    },
    {
        pattern: /no rule to make target/,
        tag: 'make_no_rule',
        message: 'make 找不到生成目标的规则',
        concept: CONCEPTS.make_no_rule,
    },
    {
        pattern: /missing separator/,
        tag: 'make_missing_separator',
        message: 'Makefile 命令行缺少 Tab 缩进',
        concept: CONCEPTS.make_missing_separator,
    },
    {
        pattern: /invalid operands|no match for.*operator/,
        tag: 'operator_operand_mismatch',
        message: '运算符操作数类型不匹配',
        concept: CONCEPTS.operator_operand_mismatch,
    },
    {
        // MSVC C2106: '=': left operand must be l-value
        pattern: /lvalue required|left operand must be l-value/,
        tag: 'lvalue_required',
        message: '赋值号左边必须是可修改的左值',
        concept: CONCEPTS.lvalue_required,
    },
    {
        pattern: /array subscript out of bounds|subscript out of range/,
        tag: 'array_out_of_bounds',
        message: '数组下标越界',
        concept: CONCEPTS.array_out_of_bounds,
    },
    {
        pattern: /is ambiguous|candidate expects|too many arguments|too few arguments|ambiguous call to overloaded function/,
        tag: 'overload_ambiguous',
        message: '重载调用歧义',
        concept: CONCEPTS.overload_ambiguous,
    },
    {
        // MSVC C4716: 'f': must return a value
        pattern: /control reaches end of non-void function|not all control paths return a value|must return a value/,
        tag: 'control_flow_return',
        message: '非 void 函数缺少返回值',
        concept: CONCEPTS.control_flow_return,
    },
    {
        // MSVC C2227: left of '->member' must point to class/struct/union/generic type
        pattern: /base operand of '->'|request for member .* which is of non-class type|invalid types .* for array subscript|must point to class\/struct\/union/,
        tag: 'pointer_dereference_mismatch',
        message: '指针解引用方式错误（. 与 -> 混淆）',
        concept: CONCEPTS.pointer_dereference_mismatch,
    },
];

/**
 * Match an English g++/MSVC error message against known knowledge tags.
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

/**
 * Get the full KnowledgeConcept for a given tag, if it exists.
 */
export function getKnowledgeConcept(tag: string): KnowledgeConcept | undefined {
    return CONCEPTS[tag];
}

/**
 * List all KnowledgeConcept entries in deterministic tag order.
 */
export function listKnowledgeConcepts(): KnowledgeConcept[] {
    return Object.values(CONCEPTS);
}
