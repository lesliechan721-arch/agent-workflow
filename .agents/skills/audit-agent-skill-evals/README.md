# audit-agent-skill-evals

只读审核 Agent Skill Eval 的有效性和运行结果，不创建 case、不运行 Eval，也不修改生产 Skill。preflight 和 result-triage 使用 schema v3；result-triage 精确绑定实际 EvalRunBundle digest。

## 适合使用

- `preflight`：在运行前判断 suite、case 和 Oracle 是否能有效评价当前 Skill，并给出准入状态和被阻断的 case。
- `result-triage`：在运行后归因失败与方差，并判断证据是否足以支持修改 Eval、收集更多数据或提出候选 Skill 修复。

## 边界

参与 case 或 Oracle 设计的上下文不能给同一 suite 输出 `validity=pass`。Audit 只提供审核结论；兼容 runner 才能执行 Eval，生产 Skill 的修改需要单独的作者任务。
