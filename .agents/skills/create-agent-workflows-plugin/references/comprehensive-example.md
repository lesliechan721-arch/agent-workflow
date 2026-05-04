# 综合示例：code-review 插件

`references/.examples/code-review/` 目录包含一个完整的示例插件，展示了大部分插件能力的组合使用。这里故意把样例放在隐藏父目录下，避免 Codex 把示例里的 `SKILL.md` 识别成当前仓库的 repo skill。

## 目录结构

```text
code-review/
├── .agents-plugin/
│   └── plugin.json              # 完整 manifest：skills + slashCommands + MCP + extensions + buildConfig + scripts/config
├── review-skills/
│   └── review-workflow/
│       ├── SKILL.md             # 轻量审查工作流（含模板变量 {{platformName}}）
│       ├── agents/
│       │   └── openai.yaml      # Codex 平台元数据
│       └── references/
│           └── review-rules.md  # 审查规则参考文档
├── scripts/
│   ├── aw-config.mjs            # 标准 AW config helper
│   ├── lifecycle.mjs            # install / upgrade / uninstall 生命周期入口
│   └── lifecycle.test.mjs       # pnpm plugin:test 的 Node 测试
├── .mcp.json                    # MCP 服务器（远程审查服务，引用环境变量）
├── slash-commands/
│   ├── review.md                # 公共 /review 源码，启动 review-workflow
│   └── assets/
│       ├── review-16.svg
│       └── review-64.svg
└── output-styles/               # Claude 专属输出样式
    └── review-report.md         # 审查报告格式
```

## 覆盖的能力

| 能力 | 在示例中的体现 |
|------|--------------|
| Skills | `review-skills/review-workflow/` — 源码 skill 承载实际工作流 |
| Skill Triggers | `skillTriggers.review-workflow.allowInstallOverride` — 允许源码 skill 在安装时选择 `manual` / `auto` / `default` |
| Instructions | `extensions.instructions` — 审查标准，限定 `src/**` 和 `lib/**` 路径 |
| Permissions | `extensions.permissions` — git 操作权限（allow/ask/deny） |
| Hooks | `extensions.hooks` — 公共 session_start 加载配置 + before_tool 写入检查（agentOverrides 排除 Codex） |
| Native Hooks | `extensions.nativeHooks.codex` — Codex 原生 UserPromptSubmit，无 matcher |
| Agents | `extensions.agents` — review-summarizer 报告生成器 |
| MCP Servers | `.mcp.json` — 远程审查服务，Bearer token 引用 `${REVIEW_SERVICE_API_KEY}` 环境变量 |
| Public Slash Commands | `slash-commands/review.md` — 一份公共源码同时生成 Claude `/review` 和 Codex manual-only 入口 skill |
| Output Styles | `output-styles/` — Claude 专属审查报告格式 |
| Template 渲染 | `buildConfig.templates` — SKILL.md 和 `slash-commands/*.md` 中按平台渲染 `{{platformName}}`、`{{#if supportsCommands}}` |
| AW Config | `config.schema` — 跨 Claude/Codex 共享 `reviewServiceApiKey`、`reviewMode` 和 `maxFilesPerReview` |
| Config Helper | `scripts.helpers.config` + `scripts/aw-config.mjs` — lifecycle、测试和 Claude 命令结果填充可复用的标准 helper |
| Lifecycle | `scripts.lifecycle` + `scripts/lifecycle.mjs` — install/upgrade/uninstall 时读取 context 和 effective config |
| Plugin Test | `scripts.tests.node` + `scripts/lifecycle.test.mjs` — 用 `pnpm plugin:test code-review` 验证 helper 与 lifecycle |
| agentOverrides | hooks 中的 before_tool 条目通过 `"codex": null` 排除 Codex 平台 |

示例不再使用 Claude 原生 `userConfig` 承载共享配置。跨平台配置统一写在 AW `config.schema`；Claude-only `userConfig` 只应在确实需要 Claude Code 原生能力时使用，详见 `references/claude-only-capabilities.md`。

## 构建产物预览

运行 `pnpm build` 后，两个平台的 embedded bundle 内容不同。此外，Codex 的 extensions 产物不在 build 阶段生成，而是在安装阶段由 `CodexAdapter.installExtensions()` 动态写入。

**Claude bundle（build 时写入）**：skills、.mcp.json、generated `commands/`、output-styles、hooks.json（公共 hook 渲染结果）、agents markdown、rules markdown、AW scripts/config bundle metadata

**Codex bundle（build 时写入）**：源码 skill（`review-workflow`）和 slashCommands 生成的 manual-only 入口 skill（`review`）、.mcp.json、AW scripts/config bundle metadata（+ fileRules 额外选中的源码文件，如有）

**两个平台 bundle 都不包含**：原始 `slash-commands/` 源目录

**两个平台 runtime bundle 都不包含**：`scripts.tests.node` 测试入口和 test-only helper

**Codex bundle 不包含**：output-styles/、Claude-only manifest overrides、extensions 衍生产物（均在安装时生成）

**安装/升级时执行**：`scripts.lifecycle.install` / `scripts.lifecycle.upgrade` 会收到 `AW_PLUGIN_CONTEXT`，其中包含 effective config、config sources、平台、scope、bundle root 和生成 artifacts。失败会阻断命令。

**卸载时执行**：`scripts.lifecycle.uninstall` 优先使用 ledger 里的安装快照，避免当前 marketplace 已刷新时误用新版脚本。`aw uninstall` 默认保留 AW config，清理残留配置需要显式运行 `aw config reset code-review -s user|project --yes`。

**Codex user scope native 行为**：安装 `aw install code-review -p codex -s user` 时，AW 会注册本地 marketplace，并调用 `codex app-server` 的 `plugin/install` RPC。成功后 Codex 侧必须同时有 `[plugins."code-review@aw"].enabled = true` 和 materialized cache；`aw status --json` 中 `native.pluginInstalled` 表示 cache installed，`native.pluginEnabled` 表示 config enabled。若 RPC 成功但 AW 后续步骤失败，会在 `<AW_HOME>/native-recovery/codex/user/code-review@aw.json` 留 recovery breadcrumb，重新 install 可 repair，breadcrumb-only uninstall 可清残留且不运行 uninstall lifecycle。

**Codex 安装时生成的 repo-managed artifacts**（project scope）：源码 skill `.agents/skills/review-workflow`、公共 `slashCommands` 生成的 `.agents/skills/review` manual-only 入口 skill、`.codex/config.toml` 中的 instructions managed blocks 和 `mcp_servers`、`prefix_rule(...)` rules files、`hooks.<Event>[]` hooks.json（包含目标平台生效的公共 hooks 与 `nativeHooks.codex`）、agents .toml，以及 `.codex/.agent-workflows-manifest.json` tracking。MCP server 的 tracking `artifactKey` 使用 `.mcp.json` 中的原始 key；若 key 需要 quoted TOML，写入后仍按同一个 key 识别。

**Codex project scope native 行为**：安装 `aw install code-review -p codex -s project` 只写上面的 repo-managed artifacts，不调用 `codex plugin marketplace add`，也不启动 `codex app-server`。即使 PATH 缺少 `codex` 可执行文件，只要 project surface 可安装，也不能产生用户级 config/cache 副作用。示例包含 skills、MCP、slashCommands 和 extensions，因此可 project 安装；如果插件只包含 `apps` 或纯 native-only 能力，Codex project scope 会 fail fast。
