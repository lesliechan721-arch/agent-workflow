# Safe Plugin Removal

删除属于 Catalog composition：

1. 从 status inventory 唯一确定 plugin；
2. 检查反向依赖和用户授权；
3. 运行 `aw plugin remove --help`；
4. 只使用公开参数执行 remove；不得 `rm -rf`、猜 `--force` 或手改 tombstone/ledger；
5. 删除后重新运行 Catalog status/build/validate；不得对已删除 plugin 运行 validate/test/build，inventory 为空时不运行 plugin 命令；
6. 返回结构化 CLI receipt 和剩余依赖影响。
