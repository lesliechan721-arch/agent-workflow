# 依赖合同

- 插件依赖：`agent-skill-toolkit >= 0.1.0`。
- 执行包：`@lesliechan721/agent-skill-eval >= 0.1.0`，通过 `aw-skill-eval` 提供稳定命令。
- 审核证据：`audit-agent-skill-evals` 的 `preflight` 结果，且目标 Skill digest 和 case corpus digest 必须匹配 execution plan。

运行时要求 capabilities schema v1、plan/bundle schema v2 和 audit schema v3。preflight audit 必须设置 `runBundleDigest=null`。命令、schema、Audit 或 digest 绑定不满足要求时 fail closed；不提供备用 runner、validator 或 Oracle。
