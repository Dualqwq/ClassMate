// run14 取证夹具(bug1-single-27 的原始回答):
// 模型把标记写成竞线开头 {{ref|targetId|name}},当时全链路未识别而直达学生。
export const RUN14_SINGLE27_ANSWER = `是的，{{ref|sym:creature.h:Creature:takeDamage|takeDamage}} 是继承来的方法。

**原因：**

- {{ref|sym:creature.h:Creature:takeDamage|takeDamage}} 定义在 {{ref|sym:creature.h:Creature|Creature}} 基类中（creature.h 第 29 行），是 \`public\` 成员函数。
- {{ref|sym:player.h:Player|Player}} 和 {{ref|sym:monster.h:Monster|Monster}} 都通过 \`class Player : public Creature\`、\`class Monster : public Creature\` 继承自 {{ref|sym:creature.h:Creature|Creature}}。
- 继承的 \`public\` 成员在派生类中仍然是 \`public\`，所以 {{ref|sym:player.h:Player|Player}} 和 {{ref|sym:monster.h:Monster|Monster}} 的对象可以直接调用 {{ref|sym:creature.h:Creature:takeDamage|takeDamage}}，不需要重新定义。

**下一步：** 你可以看看 {{ref|sym:monster.h:Monster:takeTurn|takeTurn}} 函数里被注释掉的那行 \`player.takeDamage(attack_);\`，把它取消注释就能让怪物攻击玩家了。`;
