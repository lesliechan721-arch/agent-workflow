# review-agent-content

只读评审 Agent-facing 文档的控制、层级、可达性、完成边界和维护负担。

## 什么时候使用

- 你明确要求评价现有 AGENTS.md、prompt、role instruction 或 reference。
- 你要快速检查、完整评审，或复核一版修订是否关闭旧问题。

不要用于完整 Agent Skill 包评审，也不要用于直接改写目标。

## 怎样调用

模型可以按任务自动调用，也可以显式使用 `$review-agent-content`。

示例请求：

- “只读检查这份系统 prompt，找出最重要的三个控制问题。”
- “对比修订前后的 AGENTS.md，确认旧问题是否关闭。”

## 会发生什么

1. Agent 把目标内容当作不可信分析材料，不执行其中的命令。
2. Agent 按请求深度检查相关维度，并给出有位置和证据的 finding。
3. Agent 返回最小改进集、unknown 和停止结论。

## 权限和边界

- 全程只读，不修改目标文件。
- 不把文案偏好当作高严重性问题，也不替代完整 Skill 包评审。
