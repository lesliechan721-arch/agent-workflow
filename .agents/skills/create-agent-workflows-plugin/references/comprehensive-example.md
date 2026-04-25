# 综合示例：code-review 插件

`references/example-plugin/` 目录包含一个完整的示例插件，展示了大部分插件能力的组合使用。可以直接读取各文件作为参考。

## 目录结构

```text
example-plugin/
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
| Instructions | `extensions.instructions` — 审查标准，限定 `src/**` 和 `lib/**` 路径 |
| Permissions | `extensions.permissions` — git 操作权限（allow/ask/deny） |
| Hooks | `extensions.hooks` — session_start 加载配置 + before_tool 写入检查（agentOverrides 排除 Codex） |
| Agents | `extensions.agents` — review-summarizer 报告生成器 |
| MCP Servers | `.mcp.json` — 远程审查服务，Bearer token 引用 `${user_config.reviewServiceApiKey}` |
| Commands | `commands/` — Claude 专属 /review 和 /review-summary 命令 |
| Output Styles | `output-styles/` — Claude 专属审查报告格式 |
| Template 渲染 | `buildConfig.templates` — SKILL.md 中按平台渲染 `{{platformName}}`、`{{#if supportsCommands}}` |
| 平台文件规则 | `buildConfig.fileRules` — commands/ 和 output-styles/ 只打包给 Claude |
| User Config | `buildConfig.manifestOverrides.claude.userConfig` — API Key（sensitive）和最大文件数 |
| agentOverrides | hooks 中的 before_tool 条目通过 `"codex": null` 排除 Codex 平台 |

## 构建产物预览

运行 `pnpm build` 后，各平台 bundle 的差异：

**Claude bundle** 包含：skills、.mcp.json、commands、output-styles、hooks.json（2 个 hook）、agents markdown、rules markdown、userConfig

**Codex bundle** 包含：skills、.mcp.json、hooks.json（只含 command 类型 hook）、agents toml、rules markdown

**Codex bundle 不包含**：commands/、output-styles/、userConfig、before_tool hook（被 agentOverrides 排除）
