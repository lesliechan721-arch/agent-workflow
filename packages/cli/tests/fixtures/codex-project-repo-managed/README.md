# Codex project repo-managed fixtures

本目录固定 Codex `project` scope repo-managed 隔离改造使用的插件夹具矩阵。它不参与当前默认 `repo-template`，后续阶段可以按需复制本目录或读取 `matrix.json` 里的单个插件路径。

## Matrix

| Fixture | Plugin name | Coverage |
| --- | --- | --- |
| `skills-only` | `skills-only` | 只有显式 skill；用于验证 repo `.agents/skills`、原生调用元数据和 skills-only 不触达 project `.codex/config.toml`。 |
| `mcp-only` | `mcp-only` | 只有 MCP；包含 quoted key server `acme.tools v1` 和 sibling server `sibling-server`。 |
| `slashCommands-only` | `slash-commands-only` | 只有公共 `slashCommands`；覆盖 `claude` / `codex` 分平台 frontmatter、模板渲染和合法 `./assets/...` icon。 |
| `extensions-only` | `extensions-only` | 只有 repo-managed extensions：instructions、permissions、hooks、agents。 |
| `skills+MCP` | `skills-mcp` | skill 与 MCP 混合；用于回滚、stale prune 和 config-backed preflight 的组合路径。 |
| `instructions+MCP` | `instructions-mcp` | managed instructions 与 MCP 混合；两者都需要 project config layer 预检。 |
| `multi-MCP` | `multi-mcp` | 多 MCP server 和结构化 JSON；覆盖 string、boolean、number、array、nested object。 |
| `apps-only` | `apps-only` | 只有 apps；Codex project scope 应早失败，并提示改用 user scope。 |
| `apps-mixed` | `apps-mixed` | skill + apps；有 project-managed kind 但仍因 apps 在 project scope 早失败，不能部分安装。 |
| `native-only` | `native-only` | 没有 Codex project repo-managed kind；用于无 project 可安装内容 / native availability gate 分支。 |

负向 slash command 资源路径夹具位于 `negative/slashCommands-invalid-icon`，不放入正向 `plugins/` 根，避免通用矩阵加载时误用。

## Notes For Later Phases

- 阶段 1/2/13 可以只读取 `.agents-plugin/plugin.json` 和 `matrix.json` 来做 capability、installability 与 interactive candidate 断言。
- 阶段 6/7 负责让 `slashCommands-only` 进入真实 build / materializer；当前夹具故意保留 future schema，不应回写到 `repo-template`。
- 阶段 8/10/11/12 可复用 `mcp-only` 与 `multi-mcp` 来锁定 quoted key、sibling server、结构化 TOML round-trip、status 和 upgrade skipped 语义。
