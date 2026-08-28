import type { ParsedError } from './errorParser';

/**
 * 叶子×链签名 → 教学标签映射表(P5b,设计依据
 * cpp-template-error-parsing-research-20260825.md §3.2/§5)。
 *
 * 匹配键 = (叶子消息特征, 链内特征),值 = errorKnowledgeMap 的 concept。
 * 六条首批签名全部来自真实编译输出语料(tmp-template-error-research/):
 * 每条签名的判定特征都能在 fixture 中逐字找到;新增案例先补 fixture
 * 再写签名,杜绝凭印象造样本。匹配时本表优先于单消息通用表
 * (ERROR_PATTERNS)——模板场景的教学文案比"运算符操作数不匹配"这类
 * 通用卡更具体;未命中再回退通用表。
 */

export interface TemplateKnowledgeMatch {
    tag: string;
    message: string;
}

interface SignatureContext {
    /** 叶子 message(小写)。 */
    leaf: string;
    /** 链帧 file+signature 串联(小写);无链为空串。 */
    chain: string;
}

interface TemplateSignatureEntry {
    tag: string;
    message: string;
    test: (ctx: SignatureContext) => boolean;
}

const TEMPLATES: TemplateSignatureEntry[] = [
    {
        // 案例 1(sort+list,实测 out_c1_*.txt):叶子 no match for 'operator-',
        // 链上 std::sort [with _RAIter = _List_iterator<int>]。
        tag: 'iterator_category_mismatch',
        message: '排序算法要求随机访问迭代器',
        test: (c) =>
            c.leaf.includes("no match for 'operator-'") &&
            (c.chain.includes('std::sort') || c.leaf.includes('std::sort')) &&
            c.chain.includes('_list_iterator'),
    },
    {
        // 案例 3(自定义类型缺 operator<,实测 out_c3.txt 两种叶子形态):
        // sort 路径叶子 no match for call to '(std::less<void>) (Point&, Point&)',
        // set 路径叶子 no match for 'operator<' 且链签名含 _Compare = std::less<Point>。
        tag: 'comparator_not_defined',
        message: '自定义类型缺少 operator< 比较函数',
        test: (c) =>
            (c.leaf.includes('no match for call to') && c.leaf.includes('std::less')) ||
            (c.leaf.includes("no match for 'operator<'") && c.chain.includes('std::less')),
    },
    {
        // 案例 2(map 元素是 pair<const K,V>,实测 out_c2.txt):叶子
        // no match for call to '(lambda(pair<string,int>&)) (pair<const string,int>&)';
        // cannot bind non-const lvalue reference 变体同样要求 pair<const 特征。
        tag: 'map_value_type_const',
        message: 'map 的键带 const,元素类型是 pair<const K, V>',
        test: (c) =>
            (c.leaf.includes('no match for call to') ||
                c.leaf.includes('cannot bind non-const lvalue reference')) &&
            (c.leaf.includes('pair<const') || c.chain.includes('pair<const')),
    },
    {
        // 案例 4(自定义类型缺 operator<<,实测 out_c4.txt):报错本来就在
        // 学生行(无链),ostream 候选展开让报错长达数百行。
        tag: 'stream_output_operator',
        message: '自定义类型没有流输出运算符 operator<<',
        test: (c) =>
            c.leaf.includes("no match for 'operator<<'") &&
            ['ostream', 'ostringstream', 'ofstream', 'fstream', 'wostream'].some((t) =>
                c.leaf.includes(t)
            ),
    },
    {
        // 案例 5(对照组:依赖名缺 typename,实测 out_c5.txt)——这类错误
        // 本来就报在学生代码,不需要链,但同样值得专属教学卡。
        tag: 'dependent_name_typename',
        message: '依赖模板参数的类型名需要 typename 前缀',
        test: (c) =>
            c.leaf.includes("need 'typename' before") || c.leaf.includes('need typename'),
    },
    {
        // 案例 6(vector<bool> 代理引用,实测 out_c6.txt):报错在学生行,
        // 但 _Bit_reference/_Bit_iterator 是天书。
        tag: 'vector_bool_proxy',
        message: 'vector<bool> 的元素访问返回代理对象,不是真正的 bool&',
        test: (c) =>
            c.leaf.includes('_bit_reference') ||
            (c.leaf.includes('cannot bind non-const lvalue reference') &&
                (c.leaf.includes('_bit_iterator') || c.leaf.includes('_bit_'))),
    },
];

function buildContext(parsed: ParsedError): SignatureContext {
    const chain = parsed.templateChain;
    const chainText = chain
        ? chain.frames
              .map((f) => `${f.file ?? ''} ${f.signature ?? ''} ${f.kind}`)
              .join(' ')
              .toLowerCase()
        : '';
    return { leaf: parsed.message.toLowerCase(), chain: chainText };
}

/**
 * 对单个解析后的诊断跑模板签名表,返回命中的教学标签(按表序,最具体的
 * 在前)。无链的叶子-only 签名(ostream/vector<bool>/typename)同样在此匹配,
 * 知识卡侧与划词解释侧共用本入口。
 */
export function matchTemplateErrorToKnowledge(parsed: ParsedError): TemplateKnowledgeMatch[] {
    const ctx = buildContext(parsed);
    const matches: TemplateKnowledgeMatch[] = [];
    for (const entry of TEMPLATES) {
        if (entry.test(ctx)) {
            matches.push({ tag: entry.tag, message: entry.message });
        }
    }
    return matches;
}
