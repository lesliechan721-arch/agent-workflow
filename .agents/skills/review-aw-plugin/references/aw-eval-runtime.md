# AW Eval runtime 适配

AW 负责 materialization 和 target/profile 选择，不负责通用模型执行语义。

- Preflight 使用 `audit-agent-skill-evals`，并绑定当前 Skill 和 case corpus digest。
- 每个 runner 定义自己的执行计划输入。兼容 runner 必须返回统一的 `EvalRunBundle v3`，并在 `runner.id` 和 `runner.version` 中声明身份。
- `aw-skill-eval-runner` 的 `run-aw-skill-evals` 消费 `AwSkillEvalExecutionPlan v3`；它不执行 Audit 或 result triage。
- required Eval runner 或证据链缺失时，链不完整，release checker 阻止发布；这本身不是 Skill 缺陷。
- AW 不会把旧项目报告 publish/release、README 登记、static batch 或 currentness 迁移到 runner。
- 缺少 Claude 执行、tool trace、token usage 或 sandbox 等 provider 限制必须在证据 bundle 中明确保留。
