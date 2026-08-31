# aw-skill-eval-runner

提供默认 AW Agent Skill Eval 的单一 Agent-facing 编排入口。`run-aw-skill-evals` 依赖 `agent-skill-toolkit` 的独立 Auditor，并调用 canonical `aw`/`aw-skill-eval` 命令；插件不复制执行引擎或 Eval schema。

输入可以是现有 `AwSkillEvalExecutionPlan v4` 加 passing `EvalAuditResult v3`，也可以是 plugin/Skill/suite/profile/case/split 选择条件。后者先由 `aw skill eval prepare` 生成输入完整 plan。

当前机器合同是 Plan v4、Audit v3、Bundle v4、provider capabilities v2 和 provider output v1。执行前必须有精确覆盖当前 plan 的独立 preflight Audit，并在 Audit 通过后明确列出模型成本、外部进程、凭据、网络及临时和持久输出，再取得本次授权。公开执行入口是 `aw-skill-eval run <plan.json> --audit <audit.json>`。

执行生成 `EvalRunBundle v4`，验证后再由全新上下文输出 result-triage Audit v3。Runner 不设计或审核 case，不产出 passing preflight Audit，不修改生产 Skill，也不作 Quality Review 或 Release Check 结论。只验证时不启动 provider 或创建输出；执行中断后重新 prepare、Audit、授权和 run，不续跑 checkpoint。
