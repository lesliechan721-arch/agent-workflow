# author-aw-catalog

初始化或维护 AW Catalog Workspace 的 metadata、plugin inventory、依赖 composition、精确版本和聚合结果；安全删除也由本 Skill 编排。

它优先使用用户明确的 root，并可从 canonical plugin target 推导 root；其它请求让公开 Catalog 命令从 cwd 自动发现。插件内部源码和实际删除交给 `author-aw-plugin`。返回后只验证受影响插件与反向依赖闭包，再完成 Catalog 聚合验证。

普通维护运行 Catalog build/validate。只有用户明确要求本地使用时才运行 `catalog dev activate`；该命令自行完成 build、complete validate、managed source 注册、sync 和 readiness，不再追加独立 status 链。本 Skill 绝不发布 Catalog。
