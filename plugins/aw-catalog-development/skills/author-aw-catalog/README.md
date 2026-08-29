# author-aw-catalog

初始化当前项目、维护或安全删除一个 AW Catalog Workspace 中的 Plugin Source，并维护 metadata、plugin inventory、依赖 composition、精确版本和聚合验证。

本 Skill 先用 `aw catalog context --json` 定位 Workspace；调用方不必预先提供 root。用户明确要求初始化当前项目时，它使用 CLI 建议根初始化。插件内部源码和实际删除由 `author-aw-plugin` 修改或执行；返回后只验证受影响插件与反向依赖闭包，再对完整 inventory 做 Catalog build/validate。用户要求当前 Catalog 作为 CLI source 时，只使用 `aw catalog dev` 管理，并以 status receipt 的 `ready` 判断是否可消费。它不会自动发布远端内容。
