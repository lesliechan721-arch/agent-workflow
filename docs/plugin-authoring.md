# Plugin Authoring

插件源码位于 `plugins/<name>/`。作者只维护源码 manifest、Skill、MCP、扩展、脚本和资源；平台 manifest 与 catalog staging 由构建流程生成。

## Manifest Contract

每个插件必须有 `.agents-plugin/plugin.json`：

```json
{
  "name": "example-plugin",
  "version": "0.1.0",
  "description": "Example plugin.",
  "compatibility": {
    "aw": { "minVersion": "0.0.0" }
  },
  "marketplace": {
    "category": "workflow",
    "strict": true,
    "policy": {
      "installation": "AVAILABLE",
      "authentication": "ON_INSTALL",
      "products": ["CODEX", "CLAUDE"]
    }
  }
}
```

- `name` 使用 kebab-case。
- `version` 和 `compatibility.aw.minVersion` 使用严格 SemVer。
- `marketplace.policy.products` 省略时支持两个平台；声明时只生成对应平台内容。
- 顶层 `dependencies` 不受支持。validator 会明确返回 unsupported。
- `interface` 只提供展示信息，不开启运行时能力。

完整字段见 `.agents/skills/create-aw-plugin/references/plugin-manifest-spec.md`。

进一步阅读：`references/skills-and-triggers.md`、`references/skill-design.md`、`references/skill-scripts.md` 和 `references/skill-evaluation.md`。

## Version and Catalog

CLI version、catalog version 和 plugin version 是三套身份。插件更新通常只发布 catalog，不要求发布 CLI。

新插件使用 manifest 中的初始 version，脚手架默认使用 `0.1.0`，首版不创建 release intent。

开发期间修改已有插件的 production bundle 时，不直接提高 `.agents-plugin/plugin.json` 的 plugin version。先提交 release intent：

```bash
pnpm plugin:change:add <plugin-name> --bump major|minor|patch --summary "变更摘要"
```

作者门禁要求已有插件的 production 变化有 release intent，但允许开发和 CI 反复修改而不递增 SemVer：

```bash
pnpm build
pnpm plugin:version:check -- --base <git-ref>
```

稳定发布前统一应用 intent，然后运行 release 门禁；没有 intent 时 `--all` 成功跳过：

```bash
pnpm plugin:release:apply --all
pnpm build
pnpm plugin:version:check:release -- --base <git-ref>
```

普通构建生成不可发布的 `development-receipt.json`，使用排除 version 字段后的 `contentDigest` 标识开发内容。Beta 发布只在临时 staging 中生成 `x.y.z-beta.N`；相同内容复用已发布 beta 版本，变化内容才增加 `N`。Stable 发布才把目标版本写入源码 manifest。Skill `evals/**`、插件 `reports/**` 和 test-only 文件不进入 production bundle，因此不需要 release intent。

`@lesliechan721/aw-plugins-manifest` sidecar 与 `@lesliechan721/aw-plugins` full catalog 使用同一份 schema 2 `catalog-manifest.json`。manifest 只描述 current 单版本快照，并记录 catalog 最低 CLI 版本、sidecar/full package identity，以及每个 current plugin 的 version、最低 CLI 版本、`artifactDigest` 和 `manifestDigest`。

作者不手改 catalog manifest、platform marketplace 或 staging 输出。Sidecar 额外包含发布端专用的 `plugin-release-ledger.json`，用于保证 `plugin@version` 跨 beta/latest 对应唯一 digest；运行时 catalog schema 仍为 2。同一 catalog version 的 exact-version sidecar/full package 内容不可改变。

## Skills

所有静态和动态 Skill 源码都放在 `skills/<skill>/`。manifest `skills` 字段只声明静态 Skill 集合；仅含动态 Skill 的插件可以省略该字段。每个静态 Skill 至少有 `SKILL.md`。

Codex Skill 必须有 `agents/openai.yaml`：

```yaml
interface:
  display_name: Example
  short_description: Example workflow
policy:
  allow_implicit_invocation: true
```

Claude 调用行为来自 `SKILL.md` frontmatter：

```yaml
---
name: example
description: Use this workflow when...
disable-model-invocation: false
user-invocable: true
---
```

Skill 的触发行为只由平台原生元数据决定。AW 校验并保留这些字段，不用 config 或 CLI flag 改写它们。公共 slash command 生成的 Codex 入口固定为 manual-only。

作者脚手架创建初始 Skill 时要求独立的 `--skill-description`。`--skill-invocation` 支持 `model`、`manual` 和 `claude-model-only`，默认 `model`。字段、类型和宿主版本支持状态由 `packages/cli/src/utils/skill-frontmatter-capabilities.json` 统一定义；作者 validator 默认检查 Claude Code 2.1.88 profile，`--claude-skill-profile current` 只核对当前文档字段，不改变最低版本发布门。

向现有插件新增一个静态 Skill 使用 `scripts/add_skill.mjs`。该命令默认创建 minor release intent，不直接修改 plugin version，并按插件支持平台生成调用元数据；它不修改插件 README，也不代替 extensions、dynamic artifact 或其它能力的直接设计与编辑。

作者不需要、也不能在插件 manifest 中声明最低 Codex 或 Claude Code 版本。宿主版本门禁由 CLI 统一维护。

## Public Slash Commands

`slashCommands` 指向 Markdown 文件或目录。构建时：

- Claude 生成 `commands/*.md`。
- Codex 生成 manual-only Skill。
- `$ARGUMENTS` 等 Claude 专属填充语法不能进入 Codex 输出。
- 图标路径必须位于命令源码目录内。

## Extensions

`extensions` 可以声明：

- instructions
- permissions
- hooks
- native hooks
- agents/roles
- file rules

MCP 使用插件根 `.mcp.json` 或 manifest 指定路径。Apps 使用 Codex 原生 app 声明。平台支持和 scope 限制由构建与写入 preflight 校验。

Codex project scope 可写 `.agents/skills/`、`.codex/config.toml`、`.codex/hooks.json`、`.codex/rules/` 和 `.codex/agents/`。归属由输出中的 AW owner marker 表达。它不调用用户级 Codex plugin 命令。

## AW Config

`config.schema` 定义 AW 管理的配置。合并顺序：manifest default、user store、project shared store、project local store。

- user store：`<AW_HOME>/plugin-config/<plugin>/config.json`
- project shared：`<repo>/.agent-workflows/plugin-config/<plugin>/config.json`
- project local：`<repo>/.agent-workflows/plugin-config.local/<plugin>/config.json`

project shared 可提交。project local 默认 ignore。路径型配置不能进入 project shared，也不能影响 repo-visible artifact。

配置写入后，AW 对当前可定位 target 运行完整 reinstall。`uninstall`、`cleanup` 和 `reinstall` 保留 config；只有 `aw config reset` 删除 store。

## Dynamic Artifacts

动态 artifact 需要同时声明 `scripts.artifacts.render` 和 `artifacts.targets`。支持的 target 包括：

- `codex.skill`
- `claude.skill`
- `codex.developerInstructionsBlock`
- `codex.agentRole`

renderer 只输出 ArtifactPlan v2：

```json
{
  "version": 2,
  "artifacts": [
    {
      "id": "example-skill",
      "kind": "skill",
      "platform": "codex",
      "target": "codex.skill",
      "state": "present",
      "skillKey": "example",
      "content": {
        "files": {
          "SKILL.md": "---\nname: example\n---\n# Example\n",
          "README.md": "# Example\n",
          "agents/openai.yaml": "policy:\n  allow_implicit_invocation: true\n"
        }
      }
    }
  ]
}
```

renderer 不能直接写平台目录。动态 Skill 声明 source 时，`sourceDirs` 必须包含 `./skills/<skillKey>`；其它 source 只能是该根内的 overlay，不能进入名为 `evals` 或 `reports` 的目录。rebuild integration 合并 `sourceDirs` 和 `content.files`，要求最终树保留非空 `README.md`，再写平台输出与 owner marker。

`aw status` 不执行 renderer。它只检查 live owner 和平台组件，并输出 `present`、`absent`、`partial` 或 `error`。

## Lifecycle

支持 `install`、`upgrade`、`uninstall` 三个事件。脚本通过 `AW_PLUGIN_CONTEXT` 读取：

- event、platform、scope
- plugin name/version/rootDir
- config values/sources/schema
- artifact 列表
- AW、Codex、Claude 路径

超时优先级：CLI `--script-timeout`、manifest `scripts.timeoutMs`、默认 `30000` ms。

成功 install/upgrade 后，AW 保存 lifecycle active snapshot。uninstall 可以使用它运行 uninstall 脚本。reinstall 的 cleanup 不运行旧 snapshot；重建后使用 current bundle 运行 install lifecycle。snapshot 只服务脚本输入，不决定 live status。

Lifecycle 必须短、小、幂等，不能直接写 AW 管理的平台输出。

## Plugin Tests and Evals

```bash
pnpm plugin:test <plugin>
pnpm plugin:eval <plugin> --skill <skill> --batch-name materialization --materialize-only
pnpm plugin:eval <plugin> --skill <skill> --batch-name release
```

- `scripts.tests.node` 只进入作者测试，不进入 runtime bundle。
- plugin test 使用隔离 bundle、home 和 project。
- 每个 eval owner 在自身 Skill 源码根维护 `evals/manifest.json`。插件根 `evals/` 不受支持。
- `--skill` 必填，一次只运行一个 owner。suite 的 `skills[]` 可以声明多个 participant Skills；profile 的 `plugins[]` 可以按顺序安装当前仓库中的多个插件。这个 eval 组合不形成 production dependency。
- `evals/**` 和插件根 `reports/**` 是作者期目录，不进入 runtime bundle 或 runtime digest。Skill README 会随 Skill 发布。
- eval materialization 必须验证最终 Codex Skill 文件和原生调用 metadata。
- `trigger` 和 `conversation` suite 支持 `isolation: standard|strict`；发布级触发边界和行为归因应使用 `strict`。strict current 只保留 participants，conversation baseline 只移除 owner。单目标 trigger case 使用 `should_load_skill`；多 Skill 竞争路由使用 `expected_loaded_skills` 精确集合，并可设置 `minimumPassRate` 和 `forbidMultipleSkillLoads`。`request_user_input` 等待是 trigger 的正常终止。`strictNegativeSplits` 对单次负例错误零容忍。
- command suite 支持 `case` 时必须声明 `cases` 文档，并返回标准 `case_results[]`。中央在每个 case 的全部 repetitions 后发布检查点，遇到 `incomplete` 时停止。使用同一 `--batch-id` 时，terminal case 被复用，incomplete 或 missing case 的全部 repetitions 重新运行；完整 case target 可以组合为 `/all` release target。没有 case 合同的 suite 整体重跑，旧 attempt 仍保留。
- conversation case 默认只读。需要验证创建或修改行为时，显式使用 `sandbox: workspace-write`，并声明最小 `allowed_workspace_changes` 和非空 `artifacts`；runner 只修改隔离副本，并把越界 diff 或 artifact 断言失败记为 mechanical failure。
- 真实模型 eval 使用文件凭据存储并关闭 secret keychain storage；从普通 Terminal 显式运行，不进入普通 unit/integration。macOS 检测到 `accountsKeychainExport` 包装器路径时会在启动模型前失败，且不会修改用户 keychain search list。
- 真实模型默认要求整个会话使用 Full Access 管理后代进程。`workspace` 或 `read-only` 来源没有显式参数时，会在 keychain、进程树、报告分配和模型启动前阻断。单次 `sandbox_permissions=require_escalated` 不等于 Full Access，不得用它重试。用户明确选择 `--allow-unmanaged-processes` 时进入 `unmanaged-confirmed` 并跳过进程树探测；agent 不得自行添加参数。CLI 不能证明参数由人添加，人工确认必须由 Codex 审批或 UI 层保证。
- 真实模型 eval 可能运行几十分钟到数小时。保留同一个进程 session，首轮和后续等待都直接使用工具允许的最长响应式等待时间。等待超时不是失败；不要另开短周期状态轮询命令。
- 每次 eval 用 `--batch-name` 新建临时批次，或用 `--batch-id` 恢复或追加同批次。批次会校验源码、materialization subject、模型环境、harness、case 集和 target contract。完整 run、target、raw、scorecard 和自动汇总固定在项目 `.tmp/agent-workflows/evals/`。用户明确要求发布时，用 `review:publish` 把人读 `report.md` 和 schema v2 `summary.json` 发布到 `plugins/<plugin>/reports/<skill>/<batch-id>/`；review-only 使用 `--batch-name`。
- 插件和每个 Skill 都必须有非空 README。插件 README 只介绍插件和 Skill；Skill README 约定记录最近已 release 的正式报告。`review:publish` 不更新 README；用户另行明确要求登记时，使用 `review:release`。插件 Skill README 登记属于 production source 变化，必须由 release intent 覆盖。

## Validation

维护插件后至少运行：

```bash
pnpm build
node .agents/skills/create-aw-plugin/scripts/validate_plugin.mjs plugins/<name>
node .agents/skills/create-aw-plugin/scripts/validate_plugin.mjs plugins/<name> --claude-skill-profile current
node .agents/skills/create-aw-plugin/scripts/validate_plugin.mjs plugins/<name> --version-base <git-ref>
node .agents/skills/create-aw-plugin/scripts/check_plugin_versions.mjs --all --mode author --base <git-ref>
pnpm plugin:test <name>
pnpm plugin:eval <name> --skill <skill> --batch-name materialization --materialize-only
```

改变 manifest 或平台能力时，同时更新作者 reference、示例和 fixture。
