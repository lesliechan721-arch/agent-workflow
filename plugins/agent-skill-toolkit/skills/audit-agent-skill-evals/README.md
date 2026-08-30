# audit-agent-skill-evals

只读审核 Agent Skill Eval 的有效性和运行结果，不创建 case、不运行 Eval，也不修改生产 Skill。preflight 只接受 canonical validator 已通过的 `AwSkillEvalExecutionPlan v4`，result-triage 只接受验证通过的 `EvalRunBundle v4`；两种输出都使用 `EvalAuditResult v3`。

## 适合使用

- `preflight`：从 validated plan 精确选择 target 和 corpus，在运行前判断 case 与 Oracle 是否有效，并给出准入状态和被阻断的 case。
- `result-triage`：在运行后归因失败与方差，并判断证据是否足以支持修改 Eval、收集更多数据或提出候选 Skill 修复。

## 边界

参与 case 或 Oracle 设计的上下文不能给同一 plan 输出 `validity=pass`。没有 validated plan 的 source-only 审核也不能通过。Audit 只提供审核结论；兼容 runner 才能执行 Eval，生产 Skill 的修改需要单独的作者任务。
