# 手动依赖合同

必需插件：`agent-skill-toolkit >= 0.1.0`。

必需包：`@lesliechan721/agent-skill-eval`。启动本 Skill 前，该包必须在 `PATH` 中提供稳定的 `aw-skill-eval` 命令。不要使用 `npx`，也不要隐式安装或下载该包。最低 runtime API 版本由 `run-agent-skill-evals/SKILL.md` 定义。

必需能力：`audit-agent-skill-evals` preflight 结果，其目标 Skill digest 和 case corpus digest 必须匹配 execution plan。

该包跟随 AW lockstep 版本，没有独立的版本上界。Runtime 兼容性要求 bin 存在、capabilities schema 为 v1，且 plan、audit 和 bundle schema 为 v2。命令、兼容 schema、audit 或合同不可用时，编排 Skill 会 fail closed。它不包含备用 runner、validator、Oracle 或评审规则。standalone 进程观察不保证后代清理，也不产生 comparative 或 release-grade 证据。必须保留生成 bundle 的 evidence level 和限制。
