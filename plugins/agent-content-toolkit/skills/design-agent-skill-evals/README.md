# design-agent-skill-evals

为 Agent Skill 设计或修改可审计的 trigger、routing、behavior、outcome 或 cost Eval。

## 什么时候使用

- 你要定义测试目标、场景族、Oracle、assertion 和运行策略。
- 现有 Eval case 需要补充现实输入、错误代价或 minimal pair。

不要用它审核自己设计的 Oracle、运行高成本 Eval，或根据结果直接修改生产 Skill。

## 怎样调用

模型可以按任务自动调用，也可以显式使用 `$design-agent-skill-evals`。

示例请求：

- “为这个 Skill 设计一组 trigger 正例、near-miss 和 minimal pair。”
- “把这些 behavior case 改成可机械检查的 artifact 断言。”

## 会发生什么

1. Agent 明确 unit under test、错误代价和允许方差。
2. Agent 设计场景族、Oracle 和最小断言，并写入授权的 Eval 资产。
3. Agent 输出需要独立 preflight 审核的风险和假设。

## 权限和边界

- 可以创建或修改用户指定的 Eval case、suite 和相关资产。
- 不运行真实模型 Eval，不修改生产 Skill，也不声称 Oracle 已独立通过。
