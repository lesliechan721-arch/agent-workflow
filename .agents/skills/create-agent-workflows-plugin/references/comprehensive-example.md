# 综合示例：code-review 插件

`references/.examples/code-review/` 目录包含一个完整的示例插件，展示了大部分插件能力的组合使用。这里故意把样例放在隐藏父目录下，避免 Codex 把示例里的 `SKILL.md` 识别成当前仓库的 repo skill。

## 目录结构

```text
code-review/
├── .agents-plugin/
│   └── plugin.json              # 完整 manifest：skills + slashCommands + MCP + extensions + buildConfig
├── review-skills/
│   └── review-workflow/
│       ├── SKILL.md             # 审查工作流（含模板变量 {{platformName}}）
│       ├── agents/
│       │   └── openai.yaml      # Codex 平台元数据（保守手动触发）
│       └── references/
│           └── review-rules.md  # 审查规则参考文档
├── .mcp.json                    # MCP 服务器（远程审查服务，引用 userConfig）
├── slash-commands/
│   ├── review.md                # 公共 /review 源码（Claude 命令 + Codex manual-only skill）
│   ├── review-summary.md        # 公共 /review-summary 源码
│   └── assets/
│       ├── review-16.svg
│       └── review-64.svg
└── output-styles/               # Claude 专属输出样式
    └── review-report.md         # 审查报告格式
```

## 覆盖的能力

| 能力 | 在示例中的体现 |
|------|--------------|
| Skills | `review-skills/review-workflow/` — 含 SKILL.md、openai.yaml、references |
| Skill Triggers | `skillTriggers.review-workflow.allowInstallOverride` — 允许显式 skill 在安装时选择 `manual` / `auto` / `default` |
| Instructions | `extensions.instructions` — 审查标准，限定 `src/**` 和 `lib/**` 路径 |
| Permissions | `extensions.permissions` — git 操作权限（allow/ask/deny） |
| Hooks | `extensions.hooks` — 公共 session_start 加载配置 + before_tool 写入检查（agentOverrides 排除 Codex） |
| Native Hooks | `extensions.nativeHooks.codex` — Codex 原生 UserPromptSubmit，无 matcher |
| Agents | `extensions.agents` — review-summarizer 报告生成器 |
| MCP Servers | `.mcp.json` — 远程审查服务，Bearer token 引用 `${REVIEW_SERVICE_API_KEY}` 环境变量 |
| Public Slash Commands | `slash-commands/` — 一份公共源码同时生成 Claude `/review` / `/review-summary` 和 Codex manual-only skills |
| Output Styles | `output-styles/` — Claude 专属审查报告格式 |
| Template 渲染 | `buildConfig.templates` — SKILL.md 和 `slash-commands/*.md` 中按平台渲染 `{{platformName}}`、`{{#if supportsCommands}}` |
| User Config | `buildConfig.manifestOverrides.claude.userConfig` — Claude 原生用户配置示例（sensitive API Key 和最大文件数） |
| agentOverrides | hooks 中的 before_tool 条目通过 `"codex": null` 排除 Codex 平台 |

## 构建产物预览

运行 `pnpm build` 后，两个平台的 embedded bundle 内容不同。此外，Codex 的 extensions 产物不在 build 阶段生成，而是在安装阶段由 `CodexAdapter.installExtensions()` 动态写入。

**Claude bundle（build 时写入）**：skills、.mcp.json、generated `commands/`、output-styles、hooks.json（公共 hook 渲染结果）、agents markdown、rules markdown、userConfig

**Codex bundle（build 时写入）**：skills（含显式 skill + slashCommands 生成的 manual-only skill）、.mcp.json（+ fileRules 额外选中的源码文件，如有）

**两个平台 bundle 都不包含**：原始 `slash-commands/` 源目录

**Codex bundle 不包含**：output-styles/、userConfig、extensions 衍生产物（均在安装时生成）

**Codex 安装时生成的 repo-managed artifacts**（project scope）：`.agents/skills/review-workflow`、公共 `slashCommands` 生成的 `.agents/skills/review` / `.agents/skills/review-summary` manual-only skills、`.codex/config.toml` 中的 instructions managed blocks 和 `mcp_servers`、`prefix_rule(...)` rules files、`hooks.<Event>[]` hooks.json（包含目标平台生效的公共 hooks 与 `nativeHooks.codex`）、agents .toml，以及 `.codex/.agent-workflows-manifest.json` tracking。MCP server 的 tracking `artifactKey` 使用 `.mcp.json` 中的原始 key；若 key 需要 quoted TOML，写入后仍按同一个 key 识别。
