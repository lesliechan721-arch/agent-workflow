# Catalog composition 判断

只在维护 Workspace metadata、inventory、依赖、Catalog 版本或 development source 时读取。目录、字段和状态的机器真值来自当前公开 CLI 帮助、静态 `aw catalog status --json` 和 Core validator。

Catalog Author 拥有 Workspace identity、`plugins/marketplace-source.json`、插件集合、同 source manifest dependency graph 和精确 Catalog version。Plugin Author 拥有每个 `plugins/<name>/` 内的源码语义。只改变 lifecycle、Skill、manifest capability 或 artifact 时，直接交给 Plugin Author；Catalog Author 只在返回后重新读取 inventory、依赖和聚合结果。

依赖必须单向、可解析且无环。不要用 build import 推断 manifest dependency，也不要因为 Catalog 编排关系给底层插件增加反向依赖。

删除请求由 Catalog Author 接收。canonical plugin path 可直接确定目标；只有名称时使用当前 inventory 的唯一匹配。读取当前 inventory、目标 manifest 和反向依赖后，把实际删除交给 Plugin Author 的公开删除分支。成功后重新读取 inventory 和依赖图；只验证受影响插件和反向依赖闭包。empty inventory 不运行 plugin 命令。删除不自动 publish，也不增加 tombstone 或 retirement metadata。

`catalog.version` 标识完整 Catalog 版本；plugin `version` 标识单插件 artifact。版本只通过公开 `aw catalog version` mutation。远端 tag 和当前 CLI 是发布占用事实的机器真值；本 reference 不复制恢复算法。

普通维护先完成插件内部修改和所需闭包验证，再执行 Catalog build/validate。显式本地使用改由 `aw catalog dev activate` 一次完成 build、complete validate、managed Path source 注册、sync 和 readiness。查看或停用才使用对应 dev 命令；不得用低层 source add/update 替代。
