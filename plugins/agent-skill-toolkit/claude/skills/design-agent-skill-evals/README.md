# design-agent-skill-evals

创建或修改 Agent Skill Eval case/suite，覆盖 trigger、routing、behavior、outcome 或 cost 场景。

## 结果

交付物包含与测试目标对应的 case 或 suite、Oracle rationale、可观察 assertion、允许方差和必要的运行策略。结果会明确标记 `Audit status: not assessed`。

## 边界

本 Skill 只写 Eval 资产，不修改生产 Skill，不审核自己的 Oracle，也不运行 Eval。独立 Audit 或实际运行只在用户请求或上层工作流明确组合时进行。
