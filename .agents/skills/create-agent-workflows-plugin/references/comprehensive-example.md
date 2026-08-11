# 综合示例：code-review 插件

`references/.examples/code-review/` 目录包含一个完整的示例插件，展示了大部分插件能力的组合使用。这里故意把样例放在隐藏父目录下，避免 Codex 把示例里的 `SKILL.md` 识别成当前仓库的 repo skill。

## 目录结构

```text
code-review/
├── .agents-plugin/
│   └── plugin.json              # 完整 manifest：version + compatibility + skills + slashCommands + MCP + extensions + buildConfig + scripts/config
├── review-skills/
│   └── review-workflow/
│       ├── SKILL.md             # 审查工作流、完成标准和验证循环（含模板变量 {{platformName}}）
│       ├── agents/
│       │   └── openai.yaml      # Codex 平台元数据
│       ├── evals/
│       │   └── evals.json       # owner Skill 作者期小型、脱敏用例
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
| Skill Evals | `review-skills/review-workflow/evals/evals.json` — owner Skill 作者期真实 prompt、预期结果和输入 fixture |
| Native invocation metadata | Codex `policy.allow_implicit_invocation` 与 Claude `disable-model-invocation` / `user-invocable` — 直接声明各平台调用行为 |
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

`review-skills/review-workflow/evals/evals.json` 属于作者期质量材料，不是 runtime 指令，也不会进入 production runtime bundle。真实插件需要由同目录 `manifest.json` 声明 owner、profile 和 suite 后才能通过 `pnpm plugin:eval <plugin> --skill <skill>` 运行；本示例只保留小型、脱敏的 seed corpus。大型日志、仓库快照和私有输入应保存在项目 `.tmp/agent-workflows/evals/` 下的隔离 workspace。

插件 manifest 不支持顶层 `dependencies`。插件需要其它工具或服务时，在 Skill 说明、MCP 声明或 lifecycle 检查中明确表达要求，不得声明插件安装依赖图。

## 构建产物预览

运行 `pnpm build` 后，两个平台的 staging/runtime bundle 内容不同。Codex 的 extensions 产物由写命令的 rebuild integration 生成。正式发布时，这些 bundle 进入 `@lesliechan721/aw-plugins` full catalog 包；`@lesliechan721/aw` CLI tarball 不再把它们作为 embedded catalog fallback 发布。

**Claude bundle（build 时写入）**：skills、.mcp.json、generated `commands/`、output-styles、hooks.json（公共 hook 渲染结果）、agents markdown、rules markdown、AW scripts/config bundle metadata

**Codex bundle（build 时写入）**：源码 skill（`review-workflow`）和 slashCommands 生成的 manual-only 入口 skill（`review`）、.mcp.json、AW scripts/config bundle metadata（+ fileRules 额外选中的源码文件，如有）

**两个平台 bundle 都不包含**：原始 `slash-commands/` 源目录

**两个平台 runtime bundle 都不包含**：`scripts.tests.node` 测试入口和 test-only helper

**两个平台 runtime bundle 都不包含**：Skill 根 `evals/**`、`reports/**` 作者期语料、runner 和报告

**插件 manifest 和平台原生 manifest 都不支持**：`dependencies`。

**schema 2 catalog manifest 负责记录**：current catalog version、catalog channel、catalog 级 `compatibility.aw.minVersion`、sidecar/full package identity，以及 current 快照里每个插件的单一版本、最低 CLI 版本和 `artifactDigest` / `manifestDigest`。这些文件由发布流程生成，不手改。同一 catalog version 的 exact-version sidecar/full package 内容不可改变。

**Codex bundle 不包含**：output-styles/、Claude-only manifest overrides、extensions 衍生产物（均在安装时生成）

**安装/升级时执行**：`scripts.lifecycle.install` / `scripts.lifecycle.upgrade` 会收到 `AW_PLUGIN_CONTEXT`，其中包含 effective config、config sources、平台、scope、bundle root 和生成 artifacts。失败会阻断命令。

**卸载时执行**：`scripts.lifecycle.uninstall` 使用 lifecycle active store 保存的最后一次成功脚本输入。`aw uninstall` 和 `aw cleanup` 不删除 AW config；配置只由 `aw config reset code-review -s user|project` 清理。

**Codex user scope native 行为**：安装 `aw install code-review -p codex -s user` 时，AW 会用 `codex plugin marketplace add/list` 注册并校验本地 marketplace，再调用 `codex plugin add` 写入 native plugin。`aw status` 直接检查平台原生状态和 AW ownership marker。

**Codex 安装时生成的 repo-managed artifacts**（project scope）：源码 skill `.agents/skills/review-workflow`、公共 `slashCommands` 生成的 `.agents/skills/review` manual-only 入口 skill、`.codex/config.toml` 中的 instructions managed blocks 和 `mcp_servers`、rules、hooks 和 agents。AW ownership marker 是写入、状态检查和清理的归属真值。

**Codex project scope native 行为**：安装 `aw install code-review -p codex -s project` 只写上面的 repo-managed artifacts，不调用 `codex plugin marketplace add`，也不启动 `codex app-server`；但写入前仍要求本机 Codex `>= 0.145.0`。通过版本门禁后，project scope 不能产生用户级 config/cache 副作用。示例包含 skills、MCP、slashCommands 和 extensions，因此可 project 安装；如果插件只包含 `apps` 或纯 native-only 能力，Codex project scope 会 fail fast。

**交互与脚本化入口**：用户直接运行 `aw` 进入主控制台；配置向导只在主控制台中提供。脚本和文档示例使用 `aw config set/unset/reset` 写配置，用 `aw config list/get` 读取配置，不再使用旧的子命令交互入口。写命令的 `--json` stdout 是单一 JSON receipt；默认输出只展示友好完成状态和下一步，诊断信息进入 `--verbose`、`--debug` 或 JSON。

**Project shared/local config 与 ignore**：`aw config set code-review --scope project` 写 `.agent-workflows/plugin-config/code-review/config.json`，这是可提交的 shared config；`--scope project --local` 写 `.agent-workflows/plugin-config.local/code-review/config.json`，默认忽略，只影响本机 helper/lifecycle。模板和示例应默认忽略 local config，但不能默认忽略 `.agent-workflows/plugin-config/`。

**Dynamic artifact 和位置安全**：配置保存后，AW 对当前可见 target 运行完整 `reinstall`。renderer V2 只返回 plan，由 AW 合并、校验并写入平台输出。其它项目不会被扫描，receipt 会明确提示这些项目需要手动 reinstall。
