# Catalog composition 判断

只在维护 Workspace metadata、inventory、依赖、Catalog 版本或 development source 时读取。目录、字段和参数的机器真值来自 `aw catalog context/status ... --json`、公开 CLI 帮助和 Core validator。

Catalog Author 拥有 Workspace identity、`plugins/marketplace-source.json`、插件集合、同 source manifest dependency graph 和精确 Catalog version。Plugin Author 拥有每个 `plugins/<name>/` 内的全部源码语义。仅改变 lifecycle、Skill、manifest capability 或 artifact 时，直接交给 Plugin Author；Catalog Author 只在返回后重新检查 inventory、依赖和聚合结果。

依赖必须是单向、可解析和无环的运行时关系。不要用 build import 推断 manifest dependency，也不要因为 Catalog 编排关系给底层插件增加反向依赖。

删除请求由 Catalog Author 接收。canonical plugin path 可直接确定目标；仅有名称时用当前 inventory 的唯一匹配，名称不唯一才问。读取当前 inventory、目标 manifest 和反向依赖，再决定删除是否涉及该 Workspace 的 Catalog version policy。实际删除只交给 Plugin Author 调用公开 `aw plugin remove`；成功 receipt 返回后重新读取 inventory 和依赖图。只验证受影响插件和反向依赖闭包；inventory 为空时记录 empty inventory，不验证已删除对象。删除不自动 publish，也不增加 tombstone、retirement metadata 或 release ledger。

`catalog.version` 标识完整 Catalog candidate；plugin `version` 标识单插件 artifact。是否需要改变任一版本由目标 workspace 的规则、当前 validator/status 和已存在发布证据决定。本 reference 不缓存 ledger 结构、版本门槛或发布恢复步骤。

Catalog build 是全体已声明插件代码的聚合执行边界。先完成并验证插件内部修改，再执行聚合 build/validate。成功条件是当前 CLI 返回成功，并且输出来自生成命令，不是手工修补。

用户要求当前 Catalog 成为 CLI source 时，只使用 `aw catalog dev activate`；查看和停用只使用对应的 `catalog dev` 命令。安装测试必须消费 activate receipt 的 `source.id` 组成 `<source.id>/<plugin>`，不能为当前 Workspace 改用低层 source add/update。不要把 development source 变成发布步骤。
