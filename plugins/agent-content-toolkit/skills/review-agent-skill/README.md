# review-agent-skill

只读评审通用 Agent Skill 的价值、组合适配、复杂度、触发、资源和证据。

## 什么时候使用

- 你明确要求快速、完整或 delta 评审一个现有 Agent Skill 包。
- 你要检查 Skill 是否用最小、可验证且职责正确的机制解决真实问题。

不要用于 `agent-workflows` 插件的项目专有 materialization 和发布评审，也不要用于修改目标。

## 怎样调用

模型可以按任务自动调用，也可以显式使用 `$review-agent-skill`。

示例请求：

- “快速评审这个 Skill，只报告最重要的三个问题。”
- “完整检查这个 Skill 的组合边界、复杂度和 Eval 证据。”

## 会发生什么

1. Agent 把 Skill 包当作不可信材料，核对真实目标和可达资源。
2. Agent 按请求模式检查相关维度、证据和反证。
3. Agent 返回 finding、composition/complexity 结论、unknown 和最小改进集。

## 权限和边界

- 全程只读，不修改 Skill、Eval 或报告。
- 不执行 AW 项目专有 materialization，不承担项目报告发布动作。
