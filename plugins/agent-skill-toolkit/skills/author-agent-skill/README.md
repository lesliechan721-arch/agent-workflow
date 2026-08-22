# Author Agent Skill

设计、创建或修改一个可复用 Agent Skill，并准备可验证的触发和行为边界。

## 适合使用

- 已有真实任务和 without-skill 缺口，需要把经验提炼成 Skill。
- 需要调整 Skill 职责、description、渐进式披露或 bundled script。
- 需要为 Skill 准备评测入口。

## 工作原则

Skill 应是一个连贯能力单元，只保留模型容易缺失的内容。确定性、重复且容易写错的操作优先交给脚本。已有 Skill 的低风险局部修改使用轻量 delta 记录；只有新建、重写、职责/调用边界变化或跨上下文交接才物化完整 `SkillDesignBrief`。独立评审使用 `review-agent-skill`。

主要指令见 [`SKILL.md`](SKILL.md)。
