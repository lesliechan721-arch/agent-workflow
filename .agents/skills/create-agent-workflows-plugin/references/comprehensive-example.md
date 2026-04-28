# 综合示例：code-review 插件

`references/.examples/code-review/` 目录包含一个完整的示例插件，展示了大部分插件能力的组合使用。这里故意把样例放在隐藏父目录下，避免 Codex 把示例里的 `SKILL.md` 识别成当前仓库的 repo skill。

## 目录结构

```text
code-review/
├── .agents-plugin/
│   └── plugin.json              # 完整 manifest：skills + MCP + extensions + buildConfig
├── skills/
│   └── review/
│       ├── SKILL.md             # 审查工作流（含模板变量 {{platformName}}）
│       ├── agents/
│       │   └── openai.yaml      # Codex 平台元数据（保守手动触发）
│       └── references/
│           └── review-rules.md  # 审查规则参考文档
├── .mcp.json                    # MCP 服务器（远程审查服务，引用 userConfig）
├── commands/                    # Claude 专属命令
│   ├── review.md                # /review 命令（含参数提示）
│   └── review-summary.md        # /review-summary 命令
└── output-styles/               # Claude 专属输出样式
    └── review-report.md         # 审查报告格式
```

## 覆盖的能力

| 能力 | 在示例中的体现 |
|------|--------------|
| Skills | `skills/review/` — 含 SKILL.md、openai.yaml、references |
| Skill Triggers | `skillTriggers.review.allowInstallOverride` — 允许用户安装时选择 `manual` / `auto` / `default` |
| Instructions | `extensions.instructions` — 审查标准，限定 `src/**` 和 `lib/**` 路径 |
| Permissions | `extensions.permissions` — git 操作权限（allow/ask/deny） |
| Hooks | `extensions.hooks` — 公共 session_start 加载配置 + before_tool 写入检查（agentOverrides 排除 Codex） |
| Native Hooks | `extensions.nativeHooks.codex` — Codex 原生 UserPromptSubmit，无 matcher |
| Agents | `extensions.agents` — review-summarizer 报告生成器 |
| MCP Servers | `.mcp.json` — 远程审查服务，Bearer token 引用 `${user_config.reviewServiceApiKey}` |
| Commands | `commands/` — Claude 专属 /review 和 /review-summary 命令 |
| Output Styles | `output-styles/` — Claude 专属审查报告格式 |
| Template 渲染 | `buildConfig.templates` — SKILL.md 中按平台渲染 `{{platformName}}`、`{{#if supportsCommands}}` |
| 平台文件规则 | `buildConfig.fileRules` — commands/ 和 output-styles/ 只打包给 Claude |
| User Config | `buildConfig.manifestOverrides.claude.userConfig` — API Key（sensitive）和最大文件数 |
| agentOverrides | hooks 中的 before_tool 条目通过 `"codex": null` 排除 Codex 平台 |

## 构建产物预览

运行 `pnpm build` 后，两个平台的 embedded bundle 内容不同。此外，Codex 的 extensions 产物不在 build 阶段生成，而是在安装阶段由 `CodexAdapter.installExtensions()` 动态写入。

**Claude bundle（build 时写入）**：skills、.mcp.json、commands、output-styles、hooks.json（公共 hook 渲染结果）、agents markdown、rules markdown、userConfig

**Codex bundle（build 时写入）**：skills、.mcp.json（+ fileRules 选中的源码文件）

**Codex bundle 不包含**：commands/、output-styles/、userConfig、extensions 衍生产物（均在安装时生成）

**Codex 安装时生成的 repo-managed artifacts**：instructions managed blocks、`prefix_rule(...)` rules files、`hooks.<Event>[]` hooks.json（包含目标平台生效的公共 hooks 与 `nativeHooks.codex`）、agents .toml
