# MCP / App 作者策略

先读取 `aw plugin capabilities --json` receipt；只有 receipt 含所需领域时，才查询该领域。`.mcp.json` 和 `.app.json` 是独立源码资产，并由 manifest 的单一 `./` 路径声明。

MCP stdio 使用已安装、可发现的 executable，示例不使用隐式 package runner 安装。跨平台 secret 使用环境变量占位符；Claude `${user_config.KEY}` 只用于明确的 Claude-only runtime 资产，不能与 AW `config.schema` 混用。

App 是 Codex user-scope 能力。若需要 project scope，选择可在仓库内安全物化的 Skill、MCP、slash command 或 extension，或拆分插件。
