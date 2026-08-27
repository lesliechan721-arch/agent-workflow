# Catalog composition 判断

只在维护 Workspace metadata、inventory、依赖或 Catalog 版本时读取。目录、字段和参数的机械真值来自当前 PATH 的 `aw catalog ... --help`、`aw plugin capabilities --json` 和 Core validator。

Catalog Author 拥有 Workspace identity、`plugins/marketplace-source.json`、插件集合、同 source manifest dependency graph 和精确 Catalog version。Plugin Author 拥有每个 `plugins/<name>/` 内的全部源码语义。仅改变 lifecycle、Skill、manifest capability 或 artifact 时，直接交给 Plugin Author；Catalog Author 只在返回后重新检查 inventory、依赖和聚合结果。

依赖必须是单向、可解析和无环的运行时关系。不要用 build import 推断 manifest dependency，也不要因为 Catalog 编排关系给底层插件增加反向依赖。

`catalog.version` 标识完整 Catalog candidate；plugin `version` 标识单插件 artifact。是否需要改变任一版本由目标 workspace 的规则、当前 validator/status 和已存在发布证据决定。本 reference 不缓存 ledger 结构、版本门槛或发布恢复步骤。

Catalog build 是全体已声明插件代码的聚合执行边界。先完成并验证插件内部修改，再执行聚合 build/validate。成功条件是当前 CLI 返回成功，并且输出来自生成命令，不是手工修补。
