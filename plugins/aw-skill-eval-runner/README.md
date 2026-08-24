# aw-skill-eval-runner

使用 `aw-skill-eval` 执行 Agent Skill Eval，并生成中立的 `EvalRunBundle v3`。

运行环境必须提供 Node.js 22+ 和 `aw-skill-eval` 命令。本插件不依赖 `agent-skill-toolkit`。

`run-aw-skill-evals` 可以由模型自动选择，也可由用户显式调用。它验证本次副作用授权、`AwSkillEvalExecutionPlan v3`、运行时能力和 bundle 完整性。Audit 缺失不会阻止诊断执行。

Plan 可用 `minimumEvidenceLevel` 要求比较证据。macOS/Linux 在 Full Access 或普通 Terminal 能力探测通过后使用 `verified-observed` 进程管理；受限会话仍可执行只要求 `executed` 的诊断计划。验证观察不是 OS 强隔离，限制会写入 bundle。

本插件不设计或审核 case，不调用 Auditor，也不解释结果。Review 或发布使用运行证据前，必须在消费侧完成 preflight Audit 和 result triage。
