# ClassMate V5：算法知识 Skill 审阅清单

## 1. 本次目标

让 ClassMate 在学生“不理解算法内容”时，不只回答定义和复杂度，而能解释：算法解决什么、为什么这样设计、维护什么状态、如何逐步执行、为什么正确，以及适用条件和常见误区。

## 2. 运行时结构

```text
SKILL.md
├── 核心安全与教学规则
├── 算法内容理解选择规则
└── 指示规划模型按需选择下面的小节

references/
├── algorithm-response-patterns.md   算法理解专用回答模板
├── ds-graph-algorithms.md           图算法
├── ds-tree-algorithms.md            树算法
├── ds-sorting-and-kmp.md            排序与 KMP
└── ds-high-frequency-difficulties.md 高频难点

graph/skill-graph.json
└── 保存稳定节点 ID、标题路径、关键词、学生口语别名和关系
```

最终回答不会一次加载全部文件。规划阶段最多选择相关模板和知识小节，控制器校验节点 ID 后只提取被选中的 Markdown 小节。

## 3. 算法理解回答模板

模板要求按需采用以下顺序：

1. 算法解决的问题；
2. 普通方法的困难和核心直觉；
3. 维护的状态或不变式；
4. 在最小例子上逐步执行；
5. 关键步骤为什么不会错；
6. 复杂度、适用条件和常见误区。

深度 1 只给方向，深度 2 增加完整小例子，深度 3 才给伪代码，深度 4 只在明确要求实现时提供代码。

## 4. 新增知识内容

### 图算法

| 节点 | 主要内容 |
|---|---|
| `ds.topological-sort` | 零入度队列、多解、环检测、`O(V+E)` |
| `ds.dijkstra` | `dist/settled/parent`、松弛、正确性、负边反例 |
| `ds.prim` | 跨割最轻边、`key/parent`、与 Dijkstra 区别 |
| `ds.kruskal` | 边排序、森林、安全边、避免成环 |
| `ds.union-find` | `find/union`、路径压缩、按秩合并 |
| `ds.floyd-warshall` | 中间点阶段、k 最外层、负边与负环 |

### 树算法

| 节点 | 主要内容 |
|---|---|
| `ds.binary-tree-traversal` | 前中后序、层序、递归调用栈和复杂度 |
| `ds.bst` | 查找、插入、删除三种情况、退化成链 |
| `ds.avl-rotations` | g-p-v 判断、四种旋转、顺序保持、插入删除差异 |
| `ds.splay-tree` | Zig、Zig-zig、Zig-zag、局部性和均摊复杂度 |
| `ds.b-tree` | 外存动机、节点性质、分裂、借关键码、合并 |

### 排序与 KMP

| 节点 | 主要内容 |
|---|---|
| `ds.merge-sort` | 分治、两段合并、复杂度和稳定条件 |
| `ds.quick-sort` | pivot、partition 不变式、退化、三路划分 |
| `ds.sort-stability` | 相等关键码相对顺序和常见排序结论 |
| `ds.comparison-sort-lower-bound` | 决策树、`n!` 叶子、`Ω(n log n)` 边界 |
| `ds.kmp` | 主串不回退、完整匹配过程、LPS 与经典 next 两套定义 |

### 高频难点

| 节点 | 主要内容 |
|---|---|
| `ds.monotonic-stack` | 候选下标、不变式、弹栈原因、重复值规则 |
| `ds.histogram-max-rectangle` | `2,1,5,6,2,3` 完整过程、宽度公式、尾部哨兵 |
| `ds.bottom-up-heapify` | 与逐个插入区别、按高度加权证明 `O(n)` |
| `ds.hash-tombstone` | 三种槽位、试探链反例、墓碑复用和重散列 |

## 5. 关键约定

- Dijkstra 明确限制为非负边权，并区分“含负边不一定每次错”和“算法不再保证正确”。
- KMP 在给 next 数组前必须声明定义；`ababaca` 的 LPS 为 `[0,0,1,2,3,0,1]`，对应一种 `next[0]=-1` 定义为 `[-1,0,0,1,2,3,0]`。
- 快排中间结果依赖 partition 实现，不能声称只有一种唯一划分结果。
- B 树的“阶”和容量上下界以题面或课件约定为准。
- 单调栈相等时是否弹出取决于“严格”或“非严格”边界定义。

## 6. 当前规模

- `SKILL.md`：109 行；
- Skill 图：67 个节点；
- 数据结构节点：43 个；
- 回答模板节点：3 个；
- 本次新增的 5 个参考文件合计 601 行，均按标题单独提取，不会整批提交给最终回答模型。

## 7. 审阅入口

- `skill/classmate/SKILL.md`
- `skill/classmate/references/algorithm-response-patterns.md`
- `skill/classmate/references/ds-graph-algorithms.md`
- `skill/classmate/references/ds-tree-algorithms.md`
- `skill/classmate/references/ds-sorting-and-kmp.md`
- `skill/classmate/references/ds-high-frequency-difficulties.md`
- `skill/classmate/graph/skill-graph.json`
