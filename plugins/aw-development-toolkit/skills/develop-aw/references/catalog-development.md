# Catalog Development

- 初始化使用公开 `aw catalog init`，随后静态 status 确认 marker、identity 和 inventory。
- 维护 metadata、plugin inventory、manifest dependency composition 和精确 Catalog version；版本只用公开 version 命令。
- Plugin 内部修改进入 plugin branch，不直接改其 source。
- Plugin 返回后重新取得 status，验证受影响插件与反向依赖闭包。
- 已删除插件不再验证；inventory 为空时不运行 plugin 命令，仍完成 Catalog 聚合验证。
- 普通维护运行 Catalog build 和 complete validate；不手改 snapshot/digest。
- publication 不在本分支。
