# author-aw-catalog

初始化、维护或安全删除一个 AW Catalog Workspace 中的 Plugin Source，并维护 metadata、plugin inventory、依赖 composition、精确版本和聚合验证。

普通用户的删除请求从本 Skill 开始。插件内部源码和实际删除由 `author-aw-plugin` 修改或执行。本 Skill 先确认删除目标、inventory 和反向依赖，再在 receipt 返回后重新读取 Workspace，并验证所有剩余插件；empty inventory 不会尝试验证已删除对象。它不会自动发布远端内容。
