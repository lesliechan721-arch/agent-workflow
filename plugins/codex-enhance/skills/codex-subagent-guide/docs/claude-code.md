# Claude Code 适配器

公共要求见 [配置与接入](configuration.md)、[Adapter v5](protocol.md) 和 [运行生命周期](runtime.md)。

Claude Code 固定 workspace，通过持续输入及已配置的 MCP 接入，使用 mcp / turn-boundary，同时提供主动收件。

Claude 通讯开启时，首次模型输入前检查显式 `--disallowedTools` / `--disallowed-tools` 和 `--settings` JSON 或文件中的 `permissions.deny`；完整工具名、裸 MCP server 名或官方支持的 `*` 工具名通配规则若禁止本次 AW send / receive，返回 `communicationToolDenied`，不更改权限。关闭通讯时保留这些参数并执行普通任务；不从 allow 列表推断拒绝，也不扫描用户默认配置。规则依据：[Claude 权限合同](https://code.claude.com/docs/en/permissions#tool-name-wildcards)、[MCP 匹配](https://code.claude.com/docs/en/permissions#mcp)及 [CLI 参数](https://code.claude.com/docs/en/cli-reference)。
