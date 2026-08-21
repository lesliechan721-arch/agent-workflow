# agent-skill-eval-runner

手动编排已完成独立审核的 Agent Skill Eval。

插件先检查人工授权 gate 和 preflight `EvalAuditResult`，再调用共享 `aw-skill-eval` 命令验证并运行 `EvalExecutionPlan`。它将生成的 `EvalRunBundle` 交给 `audit-agent-skill-evals(result-triage)`。插件不实现 provider、snapshot、进程控制、timeout 处理、证据分级、机器 schema 或 validator。

## 依赖

使用前请手动安装：

- `agent-skill-toolkit`
- `@lesliechan721/agent-skill-eval`，并确保 `aw-skill-eval` 位于 `PATH`

不要使用 `npx`。本插件不会隐式安装依赖或访问网络。

## 使用方式

显式使用 `$run-agent-skill-evals` 并提供 plan 路径。只有用户已授权 plan 所需的模型成本、外部进程、凭据、网络访问和临时输出后，Skill 才会继续。

该包跟随 AW lockstep 版本，因此没有独立的 SemVer 上界。除非 bin 存在，且 runtime capabilities v1 与 plan/audit/bundle schema v2 兼容，否则 Skill 会 fail closed。执行路径不使用 Skill-local 脚本、provider、schema 副本或 validator。

## 边界

- preflight audit 必须来自 `audit-agent-skill-evals`，并匹配当前 Skill 和 case corpus digest。
- 共享包负责 provider 执行、runtime snapshot、进程清理、timeout、采集、bundle 验证和 evidence level 计算。
- standalone 进程观察不保证后代清理，也不产生 comparative 或 release-grade 证据。使用方必须保留 bundle 的 evidence level 和限制。
- 结果解释和失败归因必须交给 fresh-context `audit-agent-skill-evals(result-triage)`。
- 本插件不修改 production Skill，也不发布最终评审。
