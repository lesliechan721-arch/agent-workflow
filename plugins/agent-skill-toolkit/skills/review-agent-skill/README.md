# review-agent-skill

只读评审一个 Agent Skill package，包括其直接拥有的 references、scripts、assets、Eval 定义和已有证据。

## 结果

评审会给出机器检查结果、设计与复杂度判断、证据支持的关键 findings、高价值改进和会改变结论的 unknown。quick 模式默认只回答用户关注点和直接相关领域，不生成维度记录、分数、coverage 或总体 confidence。full 模式还完成固定 12 维评分，并在主报告显示总分、coverage 和 confidence 摘要。它不修改目标，也不输出发布资格。

## 选择边界

- 跨多个 Skill 的有界用户工作流使用 `review-agent-workflow`。
- 一个 AW plugin 使用 `review-aw-plugin`。
- 跨多个 AW plugin 的有界用户工作流使用 `review-aw-workflow`。
- 未界定的整个仓库或系统应先拆成明确 workflow，不能由本 Skill 给出全局通过结论。
