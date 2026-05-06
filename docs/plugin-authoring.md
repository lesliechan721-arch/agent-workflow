# Plugin Authoring

## Manifest Contract

插件源码 manifest 以 `plugins/<name>/.agents-plugin/plugin.json` 为唯一真值，`plugins/marketplace-source.json` 汇总 marketplace 元数据。

- `extensions.*`（`instructions`/`permissions`/公共 `hooks`/`nativeHooks`/`agents`）用于声明简单静态产物，不新增顶层 `claude` block
- 路径字段（`skills`、`slashCommands`、`mcpServers`、`apps`）必须以 `./` 开头，单个字符串形式
- 公共 `slashCommands` 是唯一的跨平台斜杠命令源码入口；`slash-commands/` 目录只允许根目录直属 `*.md` 命令文件和保留 `assets/`
- `skillTriggers` 只声明哪些 skill 允许用户在安装时用 `--skill-trigger` 覆盖触发策略；省略时全部 skill 都不可覆盖
- `buildConfig` 控制 build 阶段 bundle 生成，不是平台私有字段出口
- `scripts` / `config` 是 AW CLI 自管运行时能力：声明 lifecycle、动态 artifact renderer、标准配置 helper、Node package/test 入口，以及 `aw config` 使用的 schema
- `artifacts.targets` 声明动态 artifact 的静态能力面；安装、升级、status、project preflight 和 ledger snapshot 都以它作为 renderer 执行前的真值
- `marketplace.policy.products` 是插件最终支持平台的来源；它不仅控制安装和升级门禁，也会参与 build 裁剪、platform manifest/runtime 生成、平台 marketplace 过滤和 `pnpm plugin:test` 平台选择
- 不手改 `.claude-plugin/plugin.json` 或 `.codex-plugin/plugin.json`（这两个是 bundle 产物），也不把命令阶段产物回写到 `plugins/` 源码目录
- 详细约定见 `.agents/skills/create-agent-workflows-plugin/references/plugin-manifest-spec.md`

创建或维护插件时，优先从 `.agents/skills/create-agent-workflows-plugin/SKILL.md` 的场景入口开始读。

## Bundle Contract

`pnpm build` 会把每个源码插件打包到 `packages/cli/plugins-dist/plugins/<name>/`。所有插件都会保留 AW 源码 manifest 副本 `.agents-plugin/plugin.json`；平台 manifest 和 runtime 目录只在插件最终支持的平台上生成：

- 支持 Claude 时生成 `.claude-plugin/plugin.json` 和 `claude/**`，其中可包含 skills、MCP、generated commands、output styles、hooks、agents 等平台能力。
- 支持 Codex 时生成 `.codex-plugin/plugin.json` 和 `codex/**`，其中可包含 skills、MCP、apps 等平台能力。

根级 marketplace 仍有两份：`.claude-plugin/marketplace.json` 和 `.agents/plugins/marketplace.json`。两者共享 owner/interface 等根级元数据，但 entries 会按插件最终支持平台过滤；AW current catalog 仍扫描 `plugins/<name>/.agents-plugin/plugin.json`，因此不能把某个平台 marketplace 当作全部插件清单。本机 `~/.aw` 只是 embedded bundle 的同步镜像，不是新的源码真值。

AW-managed `scripts` / `config` 不会写入平台 manifest。build 会在隔离 staging 目录中处理显式 `scripts.node.build`、复制 lifecycle/helper 的静态运行时闭包和 production 依赖，并把 build 后的 staging manifest 当作发布真值；源码树不会被 manifest build 回写。运行时安装、升级、卸载不会联网安装依赖，也不会借用仓库根或宿主的 `node_modules`。

`scripts.artifacts.render` 和 `artifacts.targets` 也保留在 AW runtime bundle 的源码 manifest 中，但不会写入 Claude/Codex 原生 manifest。平台 manifest 只接收平台能识别的静态能力；动态 artifact 由 AW 在写路径里渲染、校验和落盘。

## Public Slash Commands

`slashCommands` 用一份 Markdown 源码生成目标平台的手动命令入口。源码目录通常写成 `"slashCommands": "./slash-commands"`。

```text
plugins/<name>/
└── slash-commands/
    ├── review.md
    └── assets/
        ├── review-16.svg
        └── review-64.svg
```

命令名来自根目录直属 `*.md` 文件名，必须是小写短横线格式，最长 64 字符。首版不支持子目录命名空间；`assets/` 是唯一允许的子目录，里面的 Markdown 不会生成命令。

每个命令文件必须有 YAML frontmatter。顶层只允许 `description`、`claude`、`codex`：

```markdown
---
description: 执行代码审查
claude:
  allowed-tools:
    - Bash
    - Read
  argument-hint: "[file-path]"
codex:
  description: 在 Codex 中手动执行代码审查工作流。
  interface:
    display_name: "Review Command"
    short_description: "手动代码审查命令"
    icon_small: ./assets/review-16.svg
    icon_large: ./assets/review-64.svg
    brand_color: "#2563EB"
---

对当前改动执行代码审查。
```

字段约定：

- 顶层 `description` 必填，作为两平台默认描述。
- Claude-only 字段只能放在 `claude` block：`description`、`allowed-tools`、`model`、`argument-hint`、`shell`。`allowed-tools` 可写字符串或字符串数组；`shell` 只接受 `bash` 或 `powershell`。
- Codex block 只允许 `description` 和 `interface`。`interface` 可写 `display_name`、`short_description`、`icon_small`、`icon_large`、`brand_color`、`default_prompt`。
- Codex 图标资源只能写 `./assets/...`，源文件必须位于 `slash-commands/assets/`，不能用绝对路径、`../`、反斜杠或其它目录。build 只复制被 frontmatter 引用的资源到对应 generated skill 的 `assets/`。
- Codex 生成 skill 的 `policy.allow_implicit_invocation` 固定为 `false`。作者不能在 `codex.policy` 覆盖它；这类 skill 只能由用户显式 `$command-name` 或结构化 skill mention 调用。
- 复杂、可复用的流程仍应放在源码 `skills/` 中；公共 `slashCommands` 适合作为手动快捷入口，不应替代实际 skill 工作流。
- Codex 渲染结果不能残留 `$ARGUMENTS`、`$1`、`` !`command` `` 或 ```! 这类 Claude-only 参数 / 命令结果填充语法。该校验只在插件支持 Codex、需要生成 Codex manual-only skill 时执行；Claude-only 插件不会因为 Codex forbidden syntax 被拦截。需要差异内容时，用 `buildConfig.templates` 按平台渲染。

构建结果只包含支持平台的命令产物：支持 Claude 时生成 `claude/commands/<name>.md`；支持 Codex 时生成 `codex/skills/<name>/SKILL.md` 和 `agents/openai.yaml`。原始 `slash-commands/` 不作为 runtime 目录发布。

完整字段和生成规则见 `.agents/skills/create-agent-workflows-plugin/references/slash-commands.md`。

## AW Scripts

`scripts.lifecycle` 支持 `install`、`upgrade`、`uninstall` 三个事件。生命周期脚本默认自动执行，失败会阻断对应命令；首版没有 `--no-scripts` 跳过开关。脚本可以是 Node 文件，也可以是受控 shell 文件，不能写内联 shell 命令字符串。Windows 需要提供 Node 入口，或提供 `.ps1` / `.cmd`；不要假设 Windows 环境有 `sh` / `bash`。

生命周期条目可以用字符串简写，也可以按 OS selector 写结构化对象。selector 支持 `default`、`unix`、`windows`、`linux`、`darwin`、`win32`，解析时优先窄平台，再回退到宽平台和 `default`。路径必须是插件根内的 `./` 相对路径。

Node 脚本默认只能使用 `node:` 内置模块和插件内相对 import。需要第三方依赖时，必须声明 `scripts.node.packageRoot`，并在该目录提交 `package.json` 和 `pnpm-lock.yaml`；运行时依赖写入 `dependencies`，测试/构建依赖写入 `devDependencies`。首版只接受 registry-backed 依赖，不接受 `workspace:`、`file:`、`link:`、git/HTTP/tarball 等来源，也不支持 runtime dependency install scripts。`scripts.node.build` 是唯一会触发 manifest build 的入口，且只支持 Node 文件。

`scripts.timeoutMs` 是插件默认脚本超时；用户可在 `aw install`、`aw upgrade`、`aw uninstall` 上用 `--script-timeout <ms>` 覆盖。有效范围是 `1000..300000` 毫秒。

`scripts.artifacts.render` 用于动态生成 AW 管理的 artifact plan。它只在 `install`、`upgrade`、config-triggered `refresh` 这些写路径执行；`aw status` 不会执行 renderer，也不会执行 lifecycle。首版 renderer 入口使用 `runner = "node"`，`path` 必须是插件包内的 `./` 相对路径，可选 `args` 会传给脚本。renderer 通过 `AW_PLUGIN_CONTEXT` 读取 context JSON 文件；context 包含 event、platform、scope、插件名/版本/rootDir、artifact render config、changedConfigKeys、previousArtifacts、AW/Codex/Claude home、manifestPath、renderer digest 等信息。

renderer 的 stdout 必须只输出 JSON `ArtifactPlan`，stderr 只作为失败诊断摘要。renderer 不能直接写 `.codex/config.toml`、`.codex/agents/*.toml`、`.agent-workflows-manifest.json`、ledger 或其它 AW 受管文件；它只能返回 plan。AW 会先按 manifest 校验 plan，再由对应 target runtime 统一写盘、回滚、tracking、status 和 uninstall。

示例：

```json
{
  "scripts": {
    "artifacts": {
      "render": {
        "runner": "node",
        "path": "./scripts/render-artifacts.mjs"
      }
    }
  }
}
```

## AW Config

`config.schema` 是 AW 自管配置的唯一 schema 真值，独立于 Claude 原生 `userConfig`。`aw config` 可以在插件未安装前写入配置，也可以为未安装的另一层 scope 预置覆盖值；`aw uninstall` 默认保留 AW config store，清理配置要显式运行 `aw config reset <plugin>`。

配置分为 `user` 和 `project` 两层，读取 effective config 时按 `default < user < project` 合并。写命令 `set` / `unset` / `reset` / `configure` 默认写 `user`；读命令 `get` / `list` 默认读 effective config，传 `--scope user|project` 时只看单层 store。project config root 在 git repo 或 workspace 内锚定仓库根；不在仓库内时退回 normalized command `cwd`。

动态 artifact 使用另一套 artifact render config，不能和读命令里的 effective config 混用。user scope artifact 只按 `default < user store` 渲染；project scope artifact 按 `default < user store < 当前 project store` 渲染。这样 project 覆盖只影响当前 repo 的 project artifact，不会进入 user artifact 的内容、digest、stale 判断或 refresh 结果。

`file` / `directory` 类型写入时，相对路径按 AW project root 解析，落盘为 canonical absolute realpath；每次读取 effective config 都会重新校验路径存在且类型正确。失效路径会进入 `invalid-config`，install/upgrade preflight、lifecycle context 和 helper 都会 fail closed。插件名作为 config store 路径段时只允许安全的单段名称，拒绝路径分隔符、`.`、`..`、绝对路径和 URL-like 值。

`scripts.helpers.config` 必须显式声明标准配置 helper。CLI 执行 lifecycle 或 `pnpm plugin:test` 时会通过 `AW_PLUGIN_CONTEXT` 传入已经解析好的 `config.values`、`config.sources` 和 schema；helper 没有 context 时，只读取当前 bundle 邻近的 `.agents-plugin/plugin.json` 来解释 schema/default/redaction。这意味着 helper 的 bundle 视图可能和 `aw config get/list` 的 current catalog 视图短暂不同，这是预期行为。

如果已安装的动态 artifact 在 tracking 中记录了 `refreshKeys`，`aw config set` / `configure` / `unset` / `reset` 写入后会按当前命令能定位到的 scope 自动刷新命中的 artifact。user config 写入会刷新 user target，并在当前 repo 也安装了 project target 时刷新当前 repo；project config 写入只刷新当前 repo project target。CLI 不扫描所有历史 project，tracking 会用 `refreshReach` 记录本次覆盖了 user、当前 project，还是有其它已知 project target 可能仍 stale。刷新失败不会回滚已经写入的 config store，但会把受影响 artifact 标记为最近 refresh failed，`aw status` 和 JSON receipt 会给出稳定诊断。

## Dynamic Artifacts

动态 artifact 适合“内容由配置决定，但写盘仍必须由 AW 管理”的场景。插件用 manifest 的 `artifacts.targets` 声明安装前能力真值，再用 `scripts.artifacts.render` 返回当前 scope 的 `ArtifactPlan`。安装、升级、交互式候选、project write safety preflight、status current catalog 和 ledger `capabilitySnapshot.projectManagedKinds` 都读取 `artifacts.targets`，不能等 renderer 执行后才推断插件能力。

首版动态 artifact target 只支持 Codex。声明 `artifacts.targets` 的插件必须支持 Codex，可以是 Codex-only，也可以是双平台插件中的 Codex target；Claude-only 插件声明动态 target 会在 manifest/build 校验时失败。

```json
{
  "artifacts": {
    "targets": [
      {
        "id": "lightweight-instruction",
        "platform": "codex",
        "scopes": ["user", "project"],
        "target": "codex.developerInstructionsBlock",
        "projectManagedKind": "instruction",
        "states": ["present", "disabled"],
        "refreshKeys": ["enableLightweightInstruction"],
        "requiresCodexProjectConfig": true
      },
      {
        "id": "codex-explorer-role",
        "platform": "codex",
        "scopes": ["user", "project"],
        "target": "codex.agentRole",
        "projectManagedKind": "agent",
        "states": ["present"],
        "refreshKeys": ["explorerModel"],
        "requiresCodexProjectConfig": true,
        "roleKey": "codex-explorer"
      }
    ]
  }
}
```

`ArtifactPlan` 顶层格式为 `{ "version": 1, "artifacts": [...] }`。每个 artifact 的关键字段：

- `id`：插件内稳定 id，只能使用安全字符；`pluginName + id + target` 是 AW 受管 artifact 的逻辑身份
- `target`：首版支持 `codex.developerInstructionsBlock` 和 `codex.agentRole`
- `state`：首版支持 `present` 和 `disabled`；当前 platform/scope 在 manifest 中声明过的动态 artifact 必须返回其中一种状态，不能省略
- `refreshKeys`：必须完整保留 manifest 中该 artifact 声明的 config key，且 key 必须存在于 `config.schema`
- `disabledReason`：`state = "disabled"` 时可写，例如 `config`；disabled artifact 可以没有 content，但仍要保留 `refreshKeys`

`codex.developerInstructionsBlock` 写入当前 scope 对应 Codex config 的 AW managed developer instructions block。`present` 需要 `content` 字符串；`disabled` 会移除或跳过该 artifact 对应的受管 instruction，不保留“已禁用”的运行时提示词。project scope 下它的 `projectManagedKind` 应声明为 `instruction`。

`codex.agentRole` 管理 Codex agent role 注册项和 role layer 文件。manifest target 必须静态声明 `roleKey`，用于安装前 role namespace 冲突检查；renderer plan 里的 `roleKey` 必须完全匹配。`present` content 包含 `registration.description` 和 `roleFile`；`registration.config_file` 由 AW 生成，renderer 不能提供。`roleFile.name` 必须等于 `roleKey`，可包含 Codex-only 的 `model` 和 `model_reasoning_effort`。project scope 下它的 `projectManagedKind` 应声明为 `agent`，不要把内部 `kind = "codexRole"` 写入 capability snapshot。

静态 `extensions.*` 仍然适合不依赖 AW config 动态切换的简单产物，例如固定 instructions、permissions、hooks、native hooks 或 agent 文件。已有静态插件不需要迁移到 renderer；只有当产物内容、启用状态或 role 注册需要随 AW config 刷新时，才应使用动态 artifact。

## Plugin Script Tests

插件脚本测试是开发期包脚本：

```bash
pnpm plugin:test <plugin>
pnpm plugin:test <plugin> --platform codex --scope project
pnpm plugin:test <dual-platform-plugin> --platform both --scope project
pnpm plugin:test --all
```

它不会暴露为 `aw` 客户端子命令。runner 会先用 staging 模式准备临时 bundle，并从 build 后 staging manifest 解析最终支持平台。`--platform auto` 使用完整支持平台集合；显式 `claude`、`codex`、`both` 只能缩小到最终 `products` 允许的平台，不能越过 build 裁剪。`both` 只适用于同时支持 Claude 和 Codex 的插件。

测试会在隔离 `AW_HOME`、受管临时 project root 和平台 home/temp 环境中运行 `scripts.tests.node` 匹配到的 Node 测试。测试进程的 `cwd` 是临时 project root；`AW_PLUGIN_CONTEXT.sourceRoot` 指向原始插件源码根，适合测试需要读取源码 fixture 的场景，但运行时 import 仍应命中临时 bundle。没有匹配测试时是 skipped/no-op，退出码为 0；双平台插件使用 `--platform both` 时，Codex 和 Claude 两轮会分别复制独立可写 bundle。

## Hook Contract

- `extensions.hooks` 只放跨平台公共事件：`before_tool`、`after_tool`、`session_start`。
- 公共 `session_start` 只表示 `startup / resume / clear`。Claude compact 场景请写 `extensions.nativeHooks.claude[]`，事件为 `SessionStart`，matcher 为 `compact`。
- `extensions.nativeHooks.<platform>` 用平台原生事件名，例如 Claude `Notification`、`SessionEnd`、`PreCompact`，Codex `UserPromptSubmit`、`Stop`。完整 allowlist 以 `packages/cli/src/utils/hooks-contract.ts` 为准。
- 不支持某个平台时，不能声明该平台的 `extensions.nativeHooks.<platform>`；公共 extension 条目里，unsupported platform 的非空 `agentOverrides.<platform>` 也会 fail fast。`agentOverrides.<unsupportedPlatform> = null` 合法，表示明确排除该平台。
- matcherless 原生事件不要写 `matcher`；`agentOverrides` 只用于公共 extension 条目，不用于 `nativeHooks`。
- 公共 `session_stop` 已移除；Claude `Stop` / `SessionEnd`、Codex `Stop` 都应写到对应平台的 `nativeHooks`。

## Skill Trigger Rules（两平台不共享开关）

- **Codex 自动触发**：取决于 `agents/openai.yaml` 的 `policy.allow_implicit_invocation`
- **Codex 显式触发**：用 `$skill-name` 或结构化 skill mention
- **Claude 用户手动触发**：取决于 `SKILL.md` frontmatter 的 `user-invocable`
- **Claude 模型自动调用**：取决于 `SKILL.md` frontmatter 的 `disable-model-invocation`

`.agents-plugin/plugin.json` 里的 `skillTriggers` 不定义默认触发策略，只定义安装时是否允许用户覆盖。例如：

```json
{
  "skills": "./skills",
  "skillTriggers": {
    "commit": {
      "allowInstallOverride": true
    }
  }
}
```

`allowInstallOverride: true` 表示 `aw install --skill-trigger manual|auto|default` 可以改写运行时 skill 文件；默认值仍由源码中的 `SKILL.md` 和 `agents/openai.yaml` 决定。Codex project scope 只改当前仓库 `.agents/skills/<skill>/agents/openai.yaml`，不改共享 `~/.aw` runtime。`allowInstallOverride: false` 或省略 `skillTriggers` 都会保持保守策略，不允许安装命令覆盖该 skill。

详见 `.agents/skills/create-agent-workflows-plugin/references/skills-and-triggers.md`。

## Scope Semantics

- **Claude**：`project` 和 `user` scope 都完整支持，settings 层别区分
- **Codex user scope**：使用 native plugin / marketplace 平面。AW 先注册 `~/.codex/config.toml [marketplaces.aw]`，再通过 `codex app-server` 的 `plugin/install` / `plugin/uninstall` RPC 让 Codex 写入用户级 `[plugins."<plugin>@aw"]` 和 materialized cache；安装后必须同时看到 enabled config 与 active cache。作者不能依赖“只写 config”的旧行为。
- **Codex project scope**：不启用 user native plugin，不写用户级 `[marketplaces]` 或 `[plugins]`，也不调用 native marketplace add / app-server RPC；只写当前仓库 `.agents/skills`、`.codex/config.toml`、`.codex/hooks.json`、`.codex/rules/`、`.codex/agents/` 和 `.codex/.agent-workflows-manifest.json`。缺少 `codex` 可执行文件时，repo-managed project 安装仍应可工作并且不能产生用户级 native 副作用。
- **Apps 与 Codex project installability**：`apps` 是 Codex 能力，`products=["CLAUDE"] + apps` 是矛盾配置，会在 manifest/build 校验时失败。包含 `apps` 的 Codex 插件在 project scope 会 fail fast；纯 native-only 插件也不能以 project scope 安装。面向项目安装的插件至少要提供 repo-managed surface，例如 skills、MCP、slashCommands、instructions、permissions、hooks、nativeHooks 或 agents。
- **Project key**：Claude project scope 以当前工作目录的真实路径为 key；Codex project scope 会先解析仓库根目录，再以真实路径为 key。
- **共享 runtime**：`~/.aw` 对同一用户共享。Codex user scope 和 Claude native runtime 可能因不同 scope 的 `--skill-trigger` 偏好出现 sibling drift；Codex project scope 不参与共享 runtime 选举，只改当前仓库 repo skill。
- **Tracking identity**：tracking manifest 中的 `GeneratedArtifact.path` 必须是绝对路径；`kind: "skill"` 和 `kind: "mcpServer"` 必须写 `artifactKey`。MCP `artifactKey` 使用 rendered `.mcp.json` 的原始 server key，包含点号、空格或 Unicode 时仍按 TOML quoted key 写入 `.codex/config.toml`，例如 `[mcp_servers."acme.tools v1"]`。

Codex user native 安装失败时，作者和用户会在 `aw status --json` 里看到更细的诊断：`native.pluginInstalled` 表示 cache installed，`native.pluginEnabled` 表示 config enabled，`native.recovery.present/state/reason/evidenceMatches/suggestion` 表示 `<AW_HOME>/native-recovery/codex/user/<plugin>@aw.json` 是否存在以及该如何 repair 或 cleanup。插件 lifecycle 应保持幂等，因为 native RPC 成功后如果 snapshot、lifecycle、tracking 或 ledger 失败，用户可能通过重新 `aw install` 走 repair install；breadcrumb-only uninstall 不会运行 uninstall lifecycle。
