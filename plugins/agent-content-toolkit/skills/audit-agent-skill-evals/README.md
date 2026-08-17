# audit-agent-skill-evals

只读审核 Agent Skill Eval 的 Oracle、现实性、错误代价、运行结果和修改安全。

## 什么时候使用

- 运行前检查 suite 和 case 是否有资格评价目标 Skill。
- 运行后分析 failure、方差、baseline 和结果能否驱动修改。

不要用它创建 case、运行项目专有 Eval，或直接修改生产 Skill。

## 怎样调用

模型可以按任务自动调用，也可以显式使用 `$audit-agent-skill-evals`。

示例请求：

- “运行前审核这些 trigger case 的 Oracle 和错误代价。”
- “分析这批 2/3 结果，区分 Skill 缺陷、Oracle 缺陷和模型方差。”

## 会发生什么

1. Agent 建立 Eval 与目标行为的证据链。
2. Preflight 模式检查测试层级、现实性和 Oracle；result-triage 模式检查结果归因和修改安全。
3. Agent 返回 pass、fail 或 unknown，以及最小修正方向。

## 权限和边界

- 全程只读，不修改 Skill 或 Eval 资产。
- 不运行真实模型或项目专有 runner，不把混合低样本结果直接归因给 Skill。
