# AW Eval runtime 适配

AW 负责 materialization 和 target/profile 选择，不负责通用模型执行语义。

- Preflight 使用 `audit-agent-skill-evals`，并绑定当前 Skill 和 case corpus digest。
- 兼容的可选 runner 消费 `EvalExecutionPlan` 并返回 `EvalRunBundle`。
- 缺少 runner 表示 `evalEvidenceLevel=structural`，发布证据为 provisional；这不是 Skill 缺陷。
- AW 不会把旧项目报告 publish/release、README 登记、static batch 或 currentness 迁移到通用 runner。
- 缺少 Claude 执行、tool trace、token usage 或 sandbox 等 provider 限制必须在证据 bundle 中明确保留。
