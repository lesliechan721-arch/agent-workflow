# Claude-only 作者策略

Claude-only manifest 字段属于 `buildConfig.manifestOverrides.claude`。字段集合读取 [Build 能力视图](build-config-capabilities.generated.md)；插件必须支持 CLAUDE。

- `outputStyles` 和路径形式的 LSP 配置使用插件内 `./` 路径。
- `userConfig` 只用于 Claude runtime 独占配置。跨平台值使用 AW [Config](aw-config-and-helper.md)，不能维护两份真值。
- `${user_config.KEY}` 只出现在 Claude-only 资产。共享 MCP 使用环境变量占位符或平台模板。
- Claude command/Skill 可使用其原生命令填充语法，但必须限制工具和 shell。Codex 输出不得残留该语法。
- channels 必须引用真实 MCP server，并保持认证和副作用边界明确。

需要完整当前字段时，以目标工作区 validator 和 Claude profile 校验结果为准，不从本 Skill 推断宿主内部实现。
