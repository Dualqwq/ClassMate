# Response Patterns

Use these templates when a response needs structure. Keep final answers shorter when the user's question is simple.

## Problem Understanding

```markdown
这题主要是在让你做：<一句话说明任务>。

如果先不写代码，可以先抓住这个着手点：<方向>。

你可以先确认：<一个输入/输出/规则问题>。如果这里不清楚，我可以继续帮你拆题目。
```

## Problem Hint

```markdown
可以先这样想：这题的核心是 <核心思路>。

第一步先做 <一个小步骤>，不用急着写完整程序。

如果你卡在这一步，我可以继续给你拆成更具体的步骤。
```

## Concept Explanation

```markdown
<概念> 可以先理解成：<一句话解释>。

它主要解决的是：<用途>。

放到你现在的问题里，它对应的是 <结合当前代码或题目>。

这里容易混的是：<常见误区>。
```

## Code Explanation

```markdown
这段代码整体是在做：<整体作用>。

关键部分是：

1. `<代码片段或语句>`：<解释>
2. `<代码片段或语句>`：<解释>

如果你想看变量一步一步怎么变，我可以继续帮你按一次运行过程追踪。
```

## Compile Error

```markdown
这个报错的意思是：<通俗解释>。

最可能的问题在：`<位置或代码>`。

原因是：<原因>。

可以先这样改：<最小修改建议>。
```

## Runtime Error

```markdown
这个运行错误通常说明：<通俗解释>。

你可以先检查这里：`<位置或代码>`。

最可能的原因是：<原因>。

建议先用 <验证方法> 验证一下。
```

## Wrong Output

```markdown
程序能跑但结果不对，通常要先比较三件事：

1. 题目期望输出是什么
2. 你现在实际输出是什么
3. 哪一步让这两个结果开始不一样

从你这段代码看，优先检查：<可能位置>。
```

## OJ Failure

```markdown
本地样例过了但 OJ 不过，优先怀疑隐藏测试点。

你可以先检查：

1. <边界点>
2. <输入/输出格式>
3. <实现细节>

建议自己构造一个测试：<小测试>。
```

## Mistake Summary

Use the Markdown structure defined in `SKILL.md`.

## Complete Answer Request

```markdown
可以给你完整版本，但建议你重点看注释里的 <核心知识点>，因为这才是这题真正考的地方。

```cpp
<course-level code>
```

关键是这几步：

1. <解释>
2. <解释>
```
