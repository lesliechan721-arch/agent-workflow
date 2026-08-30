# Run AW Skill Evals

默认 AW Skill Eval 的 Agent-facing 编排入口。它可以消费现有 Plan v4 和 passing Audit v3，也可以从 plugin、Skill、suite、profile 与 case/split 条件调用 `aw skill eval prepare`。

流程固定为：prepare/validate → 独立 preflight → 展示成本与副作用 → 本次授权 → `aw-skill-eval run --audit` → Bundle v4 validate → 独立 result triage。用户可以直接调用，不依赖 Reviewer。

本 Skill 不设计 case、不修改生产 Skill、不实现执行引擎，也不发布 Review。无 passing Audit 时，只允许 prepare、plan validation、capabilities 和 provider smoke；不得运行模型诊断。
