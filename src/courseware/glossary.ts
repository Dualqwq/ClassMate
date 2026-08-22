/**
 * 课程术语表：统一分词器的最长匹配叠加词库（设计文档 §5.1）。
 * - 全部小写存储；英文别名按大小写不敏感匹配，命中后以表内形式输出；
 * - Intl.Segmenter 的通用词典不识「二叉树」等领域复合词，由本表负责重组；
 * - 匹配按「最长优先」，故同族词条同时保留长短形式（如 最小生成树 / 生成树），
 *   碎片再由分词器的子串抑制剔除；
 * - 起步约 130 条中英别名，覆盖图论/代数结构/OOP 课程概念，可持续扩充。
 */
export const COURSEWARE_GLOSSARY: readonly string[] = [
	// —— 树与二叉树 ——
	'二叉树', '满二叉树', '完全二叉树', '平衡二叉树', '二叉搜索树', '二叉查找树',
	'哈夫曼树', '哈夫曼编码', '最优树', '最优二叉树', '前缀码', '前缀编码',
	'树的遍历', '先序遍历', '中序遍历', '后序遍历', '层次遍历', '遍历',
	'根树', '有序树', '树的计数', '支撑树', '生成树', '最小生成树', '最短树',
	'spanning tree', 'minimum spanning tree', 'mst', 'huffman', 'huffman coding', 'binary tree', 'traversal',
	// —— 图论 ——
	'无向图', '有向图', '完全图', '连通图', '强连通', '邻接矩阵', '关联矩阵', '邻接表',
	'adjacency matrix', 'incidence matrix',
	'入度', '出度', '割集', '割点', '基本割集', '道路', '回路', '路径', '简单道路', '简单回路',
	'欧拉图', '欧拉道路', '欧拉回路', '哈密顿道路', '哈密顿回路', '旅行商', '货郎担',
	'eulerian', 'hamiltonian', 'tsp', 'traveling salesman',
	'最短路径', '关键路径', 'PERT图', '邮路', '中国邮路',
	'shortest path', 'dijkstra', 'floyd',
	'深度优先', '广度优先', 'dfs', 'bfs',
	// —— 代数结构与群 ——
	'代数系统', '二元运算', '幺元', '单位元', '逆元', '零元', '幂等元',
	'半群', '独异点', '含幺半群', '子半群',
	'群', '子群', '循环群', '交换群', '阿贝尔群', 'abel群', '生成元',
	'陪集', '右陪集', '左陪集', '正规子群', '不变子群', '商群',
	'同态', '同构', '群同态', '群同构', '自然同态',
	'拉格朗日定理', '凯莱定理', 'abel–ruffini',
	'group', 'semigroup', 'subgroup', 'cyclic group', 'abelian group', 'generator', 'coset', 'normal subgroup', 'quotient group', 'homomorphism', 'isomorphism', 'lagrange',
	// —— 关系与集合 ——
	'等价关系', '等价类', '偏序', '偏序集', '全序', '哈斯图', '划分',
	// —— 程设 / OOP 基础 ——
	'链表', 'linked list', '数组', 'array', '栈', 'stack', '队列', 'queue',
	'哈希表', '散列表', 'hash table', '二分查找', '排序算法', '快速排序', '归并排序',
	'指针', 'pointer', '引用', 'reference', '结构体', 'struct',
	'构造函数', '析构函数', 'constructor', 'destructor',
	'封装', '继承', '多态', '重载', '运算符重载', '虚函数', '纯虚函数', '抽象类',
	'encapsulation', 'inheritance', 'polymorphism', 'overloading', 'virtual function', 'abstract class',
	'深拷贝', '浅拷贝', 'deep copy', 'shallow copy',
	'模板', 'template', '泛型编程', 'stl', '迭代器', 'iterator',
	'递归', 'recursion', '迭代', '死循环', '无限循环', 'infinite loop',
];
