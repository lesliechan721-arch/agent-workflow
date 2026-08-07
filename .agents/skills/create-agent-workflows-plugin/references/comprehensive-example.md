# 综合示例：code-review 插件

`references/.examples/code-review/` 目录包含一个完整的示例插件，展示了大部分插件能力的组合使用。这里故意把样例放在隐藏父目录下，避免 Codex 把示例里的 `SKILL.md` 识别成当前仓库的 repo skill。

## 目录结构

```text
code-review/
├── .agents-plugin/
│   └── plugin.json              # 完整 manifest：version + compatibility + skills + slashCommands + MCP + dependencies + extensions + buildConfig + scripts/config
├── review-skills/
│   └── review-workflow/
│       ├── SKILL.md             # 审查工作流、完成标准和验证循环（含模板变量 {{platformName}}）
│       ├── agents/
│       │   └── openai.yaml      # Codex 平台元数据
│       └── references/
│           └── review-rules.md  # 审查规则参考文档
├── evals/
│   └── evals.json               # 插件根作者期小型、脱敏用例
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
| Skill Evals | `evals/evals.json` — 插件根作者期真实 prompt、预期结果和输入 fixture |
| Skill Triggers | `skillTriggers.review-workflow.{defaultTrigger, allowDynamicTrigger}` — 声明默认触发策略，并允许用户通过 AW 配置改为 `manual` / `auto` |
| Instructions | `extensions.instructions` — 审查标准，限定 `src/**` 和 `lib/**` 路径 |
| Permissions | `extensions.permissions` — git 操作权限（allow/ask/deny） |
| Hooks | `extensions.hooks` — 公共 session_start 加载配置 + before_tool 写入检查（agentOverrides 排除 Codex） |
| Native Hooks | `extensions.nativeHooks.codex` — Codex 原生 UserPromptSubmit，无 matcher |
| Agents | `extensions.agents` — review-summarizer 报告生成器 |
| MCP Servers | `.mcp.json` — 远程审查服务，Bearer token 引用 `${REVIEW_SERVICE_API_KEY}` 环境变量 |
| Plugin Dependencies | `dependencies.plugins` — Codex 平台下自动确保 user scope 的 `git-commit` 至少达到指定版本 |
| Public Slash Commands | `slash-commands/review.md` — 一份公共源码同时生成 Claude `/review` 和 Codex manual-only 入口 skill |
| Output Styles | `output-styles/` — Claude 专属审查报告格式 |
| Template 渲染 | `buildConfig.templates` — SKILL.md 和 `slash-commands/*.md` 中按平台渲染 `{{platformName}}`、`{{#if supportsCommands}}` |
| AW Config | `config.schema` — 跨 Claude/Codex 共享 `reviewServiceApiKey`、`reviewMode` 和 `maxFilesPerReview` |
| Config Helper | `scripts.helpers.config` + `scripts/aw-config.mjs` — lifecycle、测试和 Claude 命令结果填充可复用的标准 helper |
| Lifecycle | `scripts.lifecycle` + `scripts/lifecycle.mjs` — install/upgrade/uninstall 时读取 context 和 effective config |
| Plugin Test | `scripts.tests.node` + `scripts/lifecycle.test.mjs` — 用 `pnpm plugin:test code-review` 验证 helper 与 lifecycle |
| agentOverrides | hooks 中的 before_tool 条目通过 `"codex": null` 排除 Codex 平台 |

示例不再使用 Claude 原生 `userConfig` 承载共享配置。跨平台配置统一写在 AW `config.schema`；Claude-only `userConfig` 只应在确实需要 Claude Code 原生能力时使用，详见 `references/claude-only-capabilities.md`。

`evals/evals.json` 属于作者期质量材料，不是 runtime 指令，也不会进入 production runtime bundle。真实插件需要由同目录 `manifest.json` 声明 profile 和 suite 后才能通过 `pnpm plugin:eval` 运行；本示例只保留小型、脱敏的 seed corpus。大型日志、仓库快照和私有输入应保存在独立 eval workspace。

示例 manifest 还包含一个带平台条件和 scope target 的依赖：

```json
{
  "version": "0.2.0",
  "compatibility": {
    "aw": {
      "minVersion": "0.8.0"
    }
  },
  "dependencies": {
    "plugins": [
      {
        "name": "git-commit",
        "minVersion": "0.3.0",
        "target": { "scope": "user" },
        "when": { "platforms": ["codex"] },
        "inheritInstallOptions": true
      }
    ]
  }
}
```

这表示 `code-review` artifact 需要 `@yiliang/aw >= 0.8.0`，安装或升级到 Codex 时需要 `git-commit >= 0.3.0`，并且依赖位置固定为 user scope；Claude 安装不会展开这条依赖。若用户安装 `code-review -p codex -s project`，AW 会优先写当前项目的 `code-review`，同时自动确保 Codex user scope 下的 `git-commit` 健康且版本满足最低要求。`inheritInstallOptions: true` 只影响自动安装 `git-commit` 时可继承的插件级安装选项；如果用户已经显式安装过该依赖，父插件卸载不会自动删除它。

## 构建产物预览

运行 `pnpm build` 后，两个平台的 staging/runtime bundle 内容不同。此外，Codex 的 extensions 产物不在 build 阶段生成，而是在安装阶段由 `CodexAdapter.installExtensions()` 动态写入。正式发布时，这些 bundle 进入 `@yiliang/aw-plugins` full catalog 包；`@yiliang/aw` CLI tarball 不再把它们作为 embedded catalog fallback 发布。

**Claude bundle（build 时写入）**：skills、.mcp.json、generated `commands/`、output-styles、hooks.json（公共 hook 渲染结果）、agents markdown、rules markdown、AW scripts/config bundle metadata

**Codex bundle（build 时写入）**：源码 skill（`review-workflow`）和 slashCommands 生成的 manual-only 入口 skill（`review`）、.mcp.json、AW scripts/config bundle metadata（+ fileRules 额外选中的源码文件，如有）

**两个平台 bundle 都不包含**：原始 `slash-commands/` 源目录

**两个平台 runtime bundle 都不包含**：`scripts.tests.node` 测试入口和 test-only helper

**两个平台 runtime bundle 都不包含**：插件根 `evals/**` 作者期语料、runner 和报告

**平台原生 manifest 都不包含**：`dependencies`。依赖声明只保留在 runtime `.agents-plugin/plugin.json`，由 AW CLI 的 dependency planner 解释。

**catalog manifest 负责记录**：catalog version、catalog channel、catalog 级 `compatibility.aw.minVersion`、sidecar/full package identity、当前快照里每个插件的单一版本，以及 history 中每个已发布插件的 `artifactDigest` / `manifestDigest`。这些文件由发布流程生成，不手改。

**Codex bundle 不包含**：output-styles/、Claude-only manifest overrides、extensions 衍生产物（均在安装时生成）

**安装/升级时执行**：`scripts.lifecycle.install` / `scripts.lifecycle.upgrade` 会收到 `AW_PLUGIN_CONTEXT`，其中包含 effective config、config sources、平台、scope、bundle root 和生成 artifacts。失败会阻断命令。

**依赖规划顺序**：安装或升级 `code-review` 时，AW 会先按当前 platform 过滤依赖。Codex 路径会先检查 / 自动安装或升级 `git-commit` 到满足 `minVersion` 的 current catalog 版本，再写入或升级 `code-review`；Claude 路径不会处理该依赖。`aw status --json` 会把这条声明放入 `dependencies.declared`，只有 Codex 位置会进入 `resolved` / `satisfied` / `missing`，并展示最低版本、已安装版本和候选版本。

**卸载时执行**：`scripts.lifecycle.uninstall` 优先使用 install record 引用的 historical lifecycle runtime，避免 current catalog 已刷新时误用新版脚本。这个 runtime 不是完整 install snapshot，只用于安全卸载。`aw uninstall` 默认保留 AW config；需要随主体卸载成功一起删除当前 target 配置时传 `--remove-config`。只清配置、不动安装状态时运行 `aw config reset code-review -s user|project --yes`。

**Codex user scope native 行为**：安装 `aw install code-review -p codex -s user` 时，AW 会用 `codex plugin marketplace add/list` 注册并校验本地 marketplace，再调用 `codex plugin add` 写入 native plugin。成功后 Codex 侧必须同时有 `[plugins."code-review@aw"].enabled = true`、active materialized cache 和 AW per-plugin record；`aw status --json` 中 `native.pluginInstalled` 表示 cache installed，`native.pluginEnabled` 表示 config enabled。`codex app-server` 的 `plugin/list`、`plugin/installed`、`plugin/read` 只用于 verbose/native view 只读诊断。顶层状态只有在 enabled config、active cache 和 AW record 都健康时才显示为 `installed`；enabled-only、cache-only 或 native transaction marker 残留都不是普通已安装。若 Codex CLI 写入成功但 AW 后续步骤失败，会留下 native transaction marker；用户可以重试同一条 install，或在状态进入 `cleanupRequired` 后运行 cleanup 收口，cleanup 不运行 uninstall lifecycle。

**Codex 安装时生成的 repo-managed artifacts**（project scope）：源码 skill `.agents/skills/review-workflow`、公共 `slashCommands` 生成的 `.agents/skills/review` manual-only 入口 skill、`.codex/config.toml` 中的 instructions managed blocks 和 `mcp_servers`、`prefix_rule(...)` rules files、`hooks.<Event>[]` hooks.json（包含目标平台生效的公共 hooks 与 `nativeHooks.codex`）、agents .toml。AW 同步维护本机 install record 和可提交的 `.agent-workflows/project-artifacts/<platform>/<sharedIdentityId>.json` project artifact shared identity；MCP server 的 `artifactKey` 使用 `.mcp.json` 中的原始 key，若 key 需要 quoted TOML，写入后仍按同一个 key 识别。

**Codex project scope native 行为**：安装 `aw install code-review -p codex -s project` 只写上面的 repo-managed artifacts，不调用 `codex plugin marketplace add`，也不启动 `codex app-server`；但写入前仍要求本机 Codex `>= 0.145.0`。通过版本门禁后，project scope 不能产生用户级 config/cache 副作用。示例包含 skills、MCP、slashCommands 和 extensions，因此可 project 安装；如果插件只包含 `apps` 或纯 native-only 能力，Codex project scope 会 fail fast。

**交互与脚本化入口**：用户直接运行 `aw` 进入主控制台；配置向导只在主控制台中提供。脚本和文档示例使用 `aw config set/unset/reset` 写配置，用 `aw config list/get` 读取配置，不再使用旧的子命令交互入口。写命令的 `--json` stdout 是单一 JSON receipt；默认输出只展示友好完成状态和下一步，诊断信息进入 `--verbose`、`--debug` 或 JSON。

**Project shared/local config 与 ignore**：`aw config set code-review --scope project` 写 `.agent-workflows/plugin-config/code-review/config.json`，这是可提交的 shared config；`--scope project --local` 写 `.agent-workflows/plugin-config.local/code-review/config.json`，默认忽略，只影响本机 helper/lifecycle。模板和示例应默认忽略 private state / local config，不要默认忽略 `.agent-workflows/plugin-config/` 或 `.agent-workflows/project-artifacts/`。

**Dynamic artifact 刷新和位置安全**：配置保存命中 `refreshKeys` 后，AW 会通过统一 apply 路径刷新当前命令能定位到的 target，并把 accepted state、digest、`lastRefresh` / `refreshReach` 写入 dynamic diagnostic cache。配置驱动的 Skill 应声明 `codex.skill` 或 `claude.skill`、静态 `skillKey` 和可选的完整目录 `sourceDirs`；renderer V2 只返回 `content.files` UTF-8 覆盖，由 AW apply 合并静态字节树、写平台 Skill runtime，并 patch 当前 effective SkillTrigger。不要用 lifecycle 直接改 Skill 文件。config refresh 和重新应用配置会从 install record 的 historical bundle 执行 renderer，不从 current local marketplace 的可变 runtime 目录读取模板。重新应用配置只重放已有配置，不改 config store；成功、失败和 skipped 都会进入 receipt，后续 `aw status --json` / `aw status --verbose` 也能读到最近一次结果。project-scope repo-visible artifact 只使用 project shared config 中可共享的非路径 key；user store、project local store 和 `file` / `directory` key 不触发 project artifact refresh。示例或测试中若同一插件出现在多个位置，状态可以汇总展示，但写动作必须先选定明确的 platform / scope / project root，不能隐式批量写多个位置。
