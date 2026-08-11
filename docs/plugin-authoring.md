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

完整字段见 `.agents/skills/create-agent-workflows-plugin/references/plugin-manifest-spec.md`。

进一步阅读：`references/skills-and-triggers.md`、`references/skill-design.md`、`references/skill-scripts.md` 和 `references/skill-evaluation.md`。

## Version and Catalog

CLI version、catalog version 和 plugin version 是三套身份。插件更新通常只发布 catalog，不要求发布 CLI。

`@lesliechan721/aw-plugins-manifest` sidecar 与 `@lesliechan721/aw-plugins` full catalog 使用同一份 schema 2 `catalog-manifest.json`。manifest 只描述 current 单版本快照，并记录 catalog 最低 CLI 版本、sidecar/full package identity，以及每个 current plugin 的 version、最低 CLI 版本、`artifactDigest` 和 `manifestDigest`。

作者不手改 catalog manifest、platform marketplace 或 staging 输出。发布流程校验 current candidate 内的最低 CLI 版本和 digest；同一 catalog version 的 exact-version sidecar/full package 内容不可改变。

## Skills

静态 Skill 放在 manifest `skills` 指向的目录中。每个 Skill 至少有 `SKILL.md`。

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
          "agents/openai.yaml": "policy:\n  allow_implicit_invocation: true\n"
        }
      }
    }
  ]
}
```

renderer 不能直接写平台目录。rebuild integration 合并 `sourceDirs` 和 `content.files`，校验最终树，再写平台输出与 owner marker。

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
pnpm plugin:eval <plugin> --skill <skill> --materialize-only
pnpm plugin:eval <plugin> --skill <skill>
```

- `scripts.tests.node` 只进入作者测试，不进入 runtime bundle。
- plugin test 使用隔离 bundle、home 和 project。
- 每个 eval owner 在自身 Skill 源码根维护 `evals/manifest.json`。插件根 `evals/` 不受支持。
- `--skill` 必填，一次只运行一个 owner。suite 的 `skills[]` 可以声明多个 participant Skills；profile 的 `plugins[]` 可以按顺序安装当前仓库中的多个插件。这个 eval 组合不形成 production dependency。
- `evals/**` 和 `reports/**` 是作者期目录，不进入 runtime bundle 或 runtime digest。
- eval materialization 必须验证最终 Codex Skill 文件和原生调用 metadata。
- `trigger` 和 `conversation` suite 支持 `isolation: standard|strict`；发布级触发边界和行为归因应使用 `strict`。strict current 只保留 participants，conversation baseline 只移除 owner。单目标 trigger case 使用 `should_load_skill`；多 Skill 竞争路由使用 `expected_loaded_skills` 精确集合，并可设置 `minimumPassRate` 和 `forbidMultipleSkillLoads`。`request_user_input` 等待是 trigger 的正常终止。`strictNegativeSplits` 对单次负例错误零容忍。
- conversation case 默认只读。需要验证创建或修改行为时，显式使用 `sandbox: workspace-write`，并声明最小 `allowed_workspace_changes` 和非空 `artifacts`；runner 只修改隔离副本，并把越界 diff 或 artifact 断言失败记为 mechanical failure。
- 真实模型 eval 使用文件凭据存储并关闭 secret keychain storage；从普通 Terminal 显式运行，不进入普通 unit/integration。macOS 检测到 `accountsKeychainExport` 包装器路径时会在启动模型前失败，且不会修改用户 keychain search list。
- 真实模型默认要求 Full Access 管理后代进程。用户显式传 `--allow-unmanaged-processes` 后可以在无 Full Access 时运行，但报告会标记无法保证后代清理。
- 中间产物固定在项目 `.tmp/agent-workflows/evals/`。持久 eval 和 review 报告分别写入 owner Skill 的 `reports/evals/<run-id>/` 与 `reports/reviews/<run-id>/`。

## Validation

维护插件后至少运行：

```bash
node .agents/skills/create-agent-workflows-plugin/scripts/validate_plugin.mjs plugins/<name>
node .agents/skills/create-agent-workflows-plugin/scripts/validate_plugin.mjs plugins/<name> --claude-skill-profile current
pnpm plugin:test <name>
pnpm plugin:eval <name> --skill <skill> --materialize-only
pnpm build
```

改变 manifest 或平台能力时，同时更新作者 reference、示例和 fixture。
