// run13 取证夹具(bug1-multi-1 T2/T3 的 correctness 修正版原文):
// T2 多文件代码块(严格校验以"恰好一个替换块"拒绝),T3 纯文字指导(零代码块被拒)。
export const RUN13_T2 = `以下是四个文件的完整修改，请根据实际代码调整成员名和类型。

### creature.h
\`\`\`cpp
void printStatus() const override {
    std::cout << name_ << " - HP: " << health_ << '/' << max_health_
              << ", Block: " << block_ << std::endl;
}
\`\`\`

### player.h
\`\`\`cpp
void playCard(int index) {
    if (index < 0 || index >= hand_.size()) return;
    Card card = hand_[index];
    card.use(*this, *this); // 假设 use 接受两个 Creature 引用
    // 删除手牌：移动元素后 pop_back
    for (int i = index; i < static_cast<int>(hand_.size()) - 1; ++i) {
        hand_[i] = hand_[i + 1];
    }
    hand_.pop_back();
}
\`\`\`

### monster.h
\`\`\`cpp
void takeTurn(Player &player) override {
    std::cout << "===== " << name_ << "'s turn =====" << std::endl;
    std::cout << name_ << " attacks " << player.getName()
              << " for " << attack_ << " damage." << std::endl;
    player.takeDamage(attack_);
}
\`\`\`

### card.h
\`\`\`cpp
void use(Creature &user, Creature &target) const {
    std::cout << user.getName() << " uses " << name_ << '.' << std::endl;
    if (type_ == CardType::ATTACK) {
        std::cout << "Deal " << value_ << " damage to " << target.getName() << std::endl;
        target.takeDamage(value_);
    } else if (type_ == CardType::SKILL) {
        std::cout << "Gain " << value_ << " block." << std::endl;
        user.gainBlock(value_);
    } else if (type_ == CardType::HEAL) {
        std::cout << "Heal " << value_ << " HP." << std::endl;
        user.heal(value_);
    }
}
\`\`\`

请根据实际代码调整成员名和类型，并确保编译通过。如果仍有问题，请提供具体报错信息。`;

export const RUN13_T3 = `在 monster.h 中，找到 takeTurn 函数，它当前为空。你需要实现怪物攻击逻辑。首先，输出回合开始行，格式为：===== [monsterName]'s turn =====，其中 [monsterName] 是 name_ 成员。然后，输出攻击行，格式为：[monsterName] attacks [playerName] for [attack] damage.，其中 [playerName] 通过 player.getName() 获取，[attack] 是 attack_ 成员。最后，调用 player.takeDamage(attack_) 对玩家造成伤害。注意：不要修改 main.cpp 和 printStatus 已实现部分，takeDamage 继承自 Creature，直接调用即可。`;
