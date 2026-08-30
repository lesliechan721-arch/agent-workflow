# aw-skill-eval-runner

提供默认 AW Agent Skill Eval 的单一 Agent-facing 编排入口。`run-aw-skill-evals` 依赖 `agent-skill-toolkit` 的独立 Auditor，并调用 canonical `aw`/`aw-skill-eval` 命令；插件不复制执行引擎或 Eval schema。

输入可以是现有 `AwSkillEvalExecutionPlan v4` 加 passing `EvalAuditResult v3`，也可以是 plugin/Skill/suite/profile/case/split 选择条件。后者先由 `aw skill eval prepare` 生成输入完整 plan。

执行前必须有精确覆盖当前 plan 的独立 preflight Audit，并在 Audit 通过后取得本次模型成本与副作用授权。执行生成 `EvalRunBundle v4`，验证后再由全新上下文输出 result-triage Audit v3。Runner 不修改 Skill，也不作 Quality Review 或 Release Check 结论。
