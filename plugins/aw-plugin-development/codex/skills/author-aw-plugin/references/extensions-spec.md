# Extensions 作者策略

先读取 `aw plugin capabilities --json` receipt；只有 receipt 含所需领域时，才查询该领域。选择能表达需求的最小 extension；平台专属事件只写对应 `nativeHooks`，公共条目用 `agentOverrides` 做有限差异。

静态规则使用 extensions。配置驱动或需要 stale/refresh 状态的输出使用 [Config](aw-config-and-helper.md)、[Lifecycle](aw-post-apply.md) 和 [Dynamic Artifact](aw-artifact-renderer.md) 合同；renderer 只返回 plan，postApply 不直接写 AW 管理的输出。

权限遵守最小授权。hook 和 agent 的外部命令必须明确、可重复执行，并说明副作用。产品被 manifest 排除时，不声明该平台的非空能力。
