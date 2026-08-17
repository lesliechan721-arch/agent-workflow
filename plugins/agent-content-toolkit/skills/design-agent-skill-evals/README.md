# Design Agent Skill Evals

为 Agent Skill 设计或修改可执行的触发、行为和组合评测。

## 适合使用

- 需要证明 Skill 相比 without-skill baseline 有增益。
- 需要增加 should-trigger、near-miss、行为或回归用例。
- Skill 修改后，需要建立 minimal pair 和相反标签检查。

## 工作原则

先定义可观察 Oracle、允许方差和失败归因条件，再写 case。评测不应只验证固定措辞或模型内部步骤。

独立审核 Oracle 和失败归因使用 `audit-agent-skill-evals`。

主要指令见 [`SKILL.md`](SKILL.md)。
