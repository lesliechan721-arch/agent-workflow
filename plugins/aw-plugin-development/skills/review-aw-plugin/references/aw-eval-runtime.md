# AW Eval runtime 适配

AW 负责 materialization 和 target/profile 选择，不负责通用模型执行语义。

- 只有静态证据不足且新运行会实质改变 Review 结论时，Reviewer 才直接调用兼容 Runner；Runner 不是 Review gate，用户也可直接调用它。
- 默认 `aw-skill-eval-runner` 接受已有 Plan+Audit，或 plugin/Skill/suite/profile/case/split 条件。后者先调用 `aw skill eval prepare` 生成 `AwSkillEvalExecutionPlan v4`。
- Runner 在全新上下文调用 `audit-agent-skill-evals` preflight。Audit fail 时停止 Eval 分支，静态 Review 可以继续。
- Engine 只执行 Audit 已通过且 exact 绑定的 Plan：`aw-skill-eval run <plan.json> --audit <audit.json>`。每个 distinct current/previous Skill digest 必须有一份 Audit。
- 兼容 runner 返回 `EvalRunBundle v4`，并在 `runner.id` 和 `runner.version` 中声明身份。bundle validate 后，Runner 在另一个全新上下文完成 result-triage Audit v3。
- release checker 按 Eval manifest 的 required profile×required suite 验收独立 Plan/Audit/Bundle/triage 链，并读取 Plan 同目录的 `preparation.json` 绑定选择条件。任一链缺失时阻止发布；这本身不是 Skill 缺陷。
- AW 不会把旧项目报告 publish/release、README 登记、旧 batch/report 或 currentness 迁移到 runner。
- 缺少 Claude 执行、tool trace、token usage 或 sandbox 等 provider 限制必须在证据 bundle 中明确保留。
