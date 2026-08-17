# Write Agent Content

创建或编辑 Agent 直接读取的项目指令、prompt、role instruction 和 reference。

## 适合使用

- 编写或重构 `AGENTS.md`、`CLAUDE.md`、系统 prompt 或 Agent 运行说明。
- 把长期规则组织成清楚的入口和按需参考。
- 修复重复、冲突、缺少完成边界或信息层级不清的问题。

## 边界

该 Skill 负责写入。独立质量判断使用 `review-agent-content`。它不会把所有说明堆入一个入口，也不会为了形式上的 DRY 牺牲局部可读性。

主要指令见 [`SKILL.md`](SKILL.md)。
