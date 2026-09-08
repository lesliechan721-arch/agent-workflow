# Development Source

只有用户明确要求本地 CLI 使用当前 Workspace 时运行 `aw catalog dev activate`。该命令拥有 build、complete validate、managed source 注册、sync 和 readiness；不要前后重复组成 build→validate→activate→status 链。

只在用户单独要求查看或停用时运行 dev status/deactivate。不使用低层 source mutation 替代。
