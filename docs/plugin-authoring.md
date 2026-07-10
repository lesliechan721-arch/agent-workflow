# Plugin Authoring

## Manifest Contract

插件源码 manifest 以 `plugins/<name>/.agents-plugin/plugin.json` 为唯一真值，`plugins/marketplace-source.json` 汇总 marketplace 元数据。

- `extensions.*`（`instructions`/`permissions`/公共 `hooks`/`nativeHooks`/`agents`）用于声明简单静态产物，不新增顶层 `claude` block
- 路径字段（`skills`、`slashCommands`、`mcpServers`、`apps`）必须以 `./` 开头，单个字符串形式
- 公共 `slashCommands` 是唯一的跨平台斜杠命令源码入口；`slash-commands/` 目录只允许根目录直属 `*.md` 命令文件和保留 `assets/`
- `skillTriggers` 为每个显式受管 skill 声明 `defaultTrigger` 和 `allowDynamicTrigger`；静态 `skills/<skill>` 和动态 `codex.skill` 必须有对应 entry，公共 `slashCommands` 生成的 Codex manual-only skill 由 AW 注入 fixed/manual 字段
- `buildConfig` 控制 build 阶段 bundle 生成，不是平台私有字段出口
- `scripts` / `config` 是 AW CLI 自管运行时能力：声明 lifecycle、动态 artifact renderer、标准配置 helper、Node package/test 入口，以及 `aw config` 使用的 schema；没有声明 `scripts.lifecycle` 或 `config.schema` 只是表示插件没有这些能力，不会被 status 当作默认问题
- `artifacts.targets` 声明动态 artifact 的静态能力面；安装、升级、status、project preflight 和 install record artifact identity 都以它作为 renderer 执行前的真值；没有声明动态 target 的静态插件不会因此产生 artifact 缺失或刷新失败诊断
- `marketplace.policy.products` 是插件最终支持平台的来源；它不仅控制安装和升级门禁，也会参与 build 裁剪、platform manifest/runtime 生成、平台 marketplace 过滤和 `pnpm plugin:test` 平台选择
- `dependencies.plugins` 声明 AW 插件之间的直接依赖；安装、升级、卸载和 status 都会用同一套 location-aware planner 解释它
- `version`、`compatibility.aw.minVersion` 和 `dependencies.plugins[].minVersion` 都使用严格 SemVer；旧式依赖 `version` / `range` 字段会被拒绝
- 作者不需要、也不能在插件 manifest 中声明最低 Codex 或 Claude Code 版本；AW CLI 内置宿主门槛，当前为 Codex `>= 0.144.0`、Claude Code `>= 2.1.88`
- 不手改 `.claude-plugin/plugin.json` 或 `.codex-plugin/plugin.json`（这两个是 bundle 产物），也不把命令阶段产物回写到 `plugins/` 源码目录
- 详细约定见 `.agents/skills/create-agent-workflows-plugin/references/plugin-manifest-spec.md`

创建或维护插件时，优先从 `.agents/skills/create-agent-workflows-plugin/SKILL.md` 的场景入口开始读。

## Version And Catalog Contract

AW 有三套独立版本身份：

- CLI version：`@yiliang/aw` 的版本，代表命令、JSON 合同和运行时能力。
- Catalog version：`@yiliang/aw-plugins-manifest` 与 `@yiliang/aw-plugins` 的共同 package version，代表一次官方 catalog 快照。
- Plugin version：单个插件 `.agents-plugin/plugin.json` 的 `version`，代表该插件 artifact 的不可变身份。

插件升级不要求 CLI 发版。只要当前 CLI 满足 catalog 和插件声明的 `compatibility.aw.minVersion`，用户就能通过 catalog 刷新看到并安装新的插件版本。

作者需要遵守这些发布边界：

- 面向 `latest` catalog 的 catalog version 和插件 version 都必须是 stable SemVer。
- `beta` catalog 的 catalog version 必须是 prerelease；同一 beta 快照可以包含 stable 或 prerelease 插件 version。
- prerelease 插件不能原样进入 `latest`。从 beta 进入 latest 时，若插件曾用 prerelease version，必须发布新的 stable 插件 version。
- 修改 runtime 内容、manifest 能力声明、依赖最低版本、最低 CLI 版本或支持平台能力时，必须发布新的插件 `version`。
- 同一 `plugin@version` 的 artifactDigest / manifestDigest 发布后不可变；不能靠覆盖同版本 artifact 修复内容，也不能只改 build metadata 作为替代版本。
- 插件 `compatibility.aw.minVersion` 不能高于目标 catalog 级 `compatibility.aw.minVersion`；catalog 级门槛是整包门槛，会决定旧 CLI 是否必须回退到历史兼容 catalog。

远程分发由两个 catalog 包组成：`@yiliang/aw-plugins-manifest` 是轻量 sidecar，只提供 `catalog-manifest.json`、兼容性、history 和 digest 真值；`@yiliang/aw-plugins` 是 full catalog 包，包含同一份 manifest 和当前快照中每个插件的一个构建后 artifact。catalog history 只用于发布门禁和历史兼容 catalog 查询，不是在最新 catalog 里安装历史插件的多版本索引。

## Bundle Contract

`pnpm build` 会把每个源码插件打成 staging/runtime bundle，供本地验证和 catalog 打包使用。所有插件都会保留 AW 源码 manifest 副本 `.agents-plugin/plugin.json`；平台 manifest 和 runtime 目录只在插件最终支持的平台上生成：

- 支持 Claude 时生成 `.claude-plugin/plugin.json` 和 `claude/**`，其中可包含 skills、MCP、generated commands、output styles、hooks、agents 等平台能力。
- 支持 Codex 时生成 `.codex-plugin/plugin.json` 和 `codex/**`，其中可包含 skills、MCP、apps 等平台能力。

根级 marketplace 仍有两份：`.claude-plugin/marketplace.json` 和 `.agents/plugins/marketplace.json`。两者共享 owner/interface 等根级元数据，但 entries 会按插件最终支持平台过滤；AW current catalog 以远程 catalog manifest 和其中的 `.agents-plugin/plugin.json` 为准，因此不能把某个平台 marketplace 当作全部插件清单。本机 `~/.aw` 是 catalog cache、active runtime view 和安装状态目录，不是新的源码真值。

AW-managed `scripts` / `config` 不会写入平台 manifest。build 会在隔离 staging 目录中处理显式 `scripts.node.build`、复制 lifecycle/helper 的静态运行时闭包和 production 依赖，并把 build 后的 staging manifest 当作发布真值；源码树不会被 manifest build 回写。运行时安装、升级、卸载不会联网安装依赖，也不会借用仓库根或宿主的 `node_modules`。

`scripts.artifacts.render` 和 `artifacts.targets` 也保留在 AW runtime bundle 的源码 manifest 中，但不会写入 Claude/Codex 原生 manifest。平台 manifest 只接收平台能识别的静态能力；动态 artifact 由 AW 在写路径里渲染、校验和落盘。

`dependencies.plugins` 同样只属于 AW runtime manifest。build 后的 `.agents-plugin/plugin.json` 会保留依赖声明并再次校验；`.claude-plugin/plugin.json`、`.codex-plugin/plugin.json` 和两份 marketplace manifest 都不会包含 `dependencies`。CLI tarball 不再把完整插件快照作为 embedded fallback 发布；正式插件 artifact 来自 `@yiliang/aw-plugins` catalog 包。

## Plugin Dependencies

插件可在 `.agents-plugin/plugin.json` 顶层声明对其它 AW 插件的直接依赖：

```json
{
  "dependencies": {
    "plugins": [
      {
        "name": "review-shared-tools",
        "minVersion": "0.4.0",
        "target": { "scope": "user" },
        "when": { "platforms": ["codex"] },
        "inheritInstallOptions": true
      }
    ]
  }
}
```

字段规则：

- `dependencies` 只允许 `plugins`；`dependencies.plugins` 必须是数组，空数组等价于无依赖但会收到作者工具 warning。
- 每个 entry 只允许 `name`、`minVersion`、`target`、`inheritInstallOptions`、`when`。
- `name` 使用和插件名相同的小写短横线格式，不能指向自己，且必须能在当前 AW catalog 中解析。
- `minVersion` 可选，表示依赖插件的最低可接受版本，必须是严格 SemVer；它不是 range，不支持上界、`^`、`~` 或比较器组合。
- `when.platforms` 只允许非空的 `codex` / `claude` 数组；省略 `when` 表示两个平台都生效。同一 manifest 内，同名依赖的平台条件不能重叠。
- `target.scope` 只允许 `user` 或 `project`。不支持 `target.platform`，依赖永远跟随父插件本次安装或升级时已经确定的平台。
- `inheritInstallOptions` 只能是 boolean。省略或 `false` 时，依赖不会继承父插件的插件级安装选项；设为 `true` 时只对需要自动安装的依赖生效，多个父插件给同一依赖传入冲突选项会 fail fast。SkillTrigger 已迁移为 AW 内建配置，不通过依赖安装选项传递。
- 不支持旧式 `version`、`range`、`marketplace`、`source`、`optional`、`dev`、`peer`、跨 marketplace 依赖、外部 URL/npm/git/local path 依赖或 dependency entry 覆盖 platform。这些字段会被作者工具和发布门禁拒绝。

scope 选择是 location-aware 的。父插件安装到 `user` scope 时，只能依赖同平台的 `user` scope 健康安装；如果当前平台生效的依赖写了 `target.scope: "project"`，命令会在写入前失败。父插件安装到 `project` scope 且依赖省略 `target.scope` 时，AW 会优先选择当前 project，当前 project 缺失或不健康时可复用 user scope；显式 `target.scope: "user"` 只看 user，显式 `target.scope: "project"` 只看当前 project，不做 fallback。

用户安装或升级父插件时，缺失依赖会自动安装，已安装但低于 `minVersion` 的依赖会自动升级到 current catalog 中满足最低版本的候选。显式 `upgrade <plugin>` 会先处理依赖再升级父插件；`upgrade --all` 只把用户显式保留的安装作为根，不会把孤立自动依赖当作根。卸载父插件时，仍被其它插件依赖的位置会受到保护；父插件卸载成功后，未被显式保留且引用归零的自动依赖会被反向拓扑自动清理。

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
    default_prompt: "使用 $review 审查当前改动。"
---

对当前改动执行代码审查。
```

字段约定：

- 顶层 `description` 必填，作为两平台默认描述。
- Claude-only 字段只能放在 `claude` block：`description`、`allowed-tools`、`model`、`argument-hint`、`shell`。`allowed-tools` 可写字符串或字符串数组；`shell` 只接受 `bash` 或 `powershell`。
- Codex block 只允许 `description` 和 `interface`。`interface` 可写 `display_name`、`short_description`、`icon_small`、`icon_large`、`brand_color`、`default_prompt`；`default_prompt` 是用户/UI 调起 generated skill 时的一句起手话，必须包含 `$command-name`，不是模型指令正文。
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

`scripts.artifacts.render` 用于动态生成 AW 管理的 artifact plan。它只在 `install`、`upgrade`、config-triggered `refresh` 这些写路径执行；`aw status` 不会执行 renderer，也不会执行 lifecycle。首版 renderer 入口使用 `runner = "node"`，`path` 必须是插件包内的 `./` 相对路径，可选 `args` 会传给脚本。renderer 通过 `AW_PLUGIN_CONTEXT` 读取 context JSON 文件；context 包含 event、platform、scope、插件名/版本/rootDir、artifact render config、changedConfigKeys、previousArtifacts、AW/Codex/Claude home、manifestPath、renderer digest 等信息。install/upgrade 时 `plugin.rootDir` 是本次安装解析出的 bundle；config refresh 和 refresh-only 时它是 install record 引用的 historical bundle，不能假设会读取当前 local marketplace。

renderer 的 stdout 必须只输出 JSON `ArtifactPlan`，stderr 只作为失败诊断摘要。renderer 不能直接写 `.agents/skills/**`、Codex user runtime skill、`.codex/config.toml`、`.codex/agents/*.toml`、project artifact identity、dynamic diagnostic cache、install record 或其它 AW 受管文件；它只能返回 plan。AW 会先按 manifest 校验 plan，再由对应 target runtime 统一写盘、回滚、诊断缓存、status 和 uninstall。

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

`config.schema` 是 AW 自管配置的唯一 schema 真值，独立于 Claude 原生 `userConfig`。`aw config` 可以在插件未安装前写入配置，也可以为未安装的另一层 scope 预置覆盖值；`aw uninstall` 默认保留 AW config store。需要在主体卸载或清理成功后一起删除当前 target scope/store 的配置时，用户可以传 `aw uninstall --remove-config` 或 `aw cleanup --remove-config`；只想删除配置、不动插件安装状态时，用 `aw config reset <plugin> -s <scope> --yes`。

配置分为 `user`、`project shared` 和 `project local`。读取 effective config 时按 `default < user < project shared < project local` 合并。脚本化写命令只有 `set` / `unset` / `reset`，默认写 `user`；读命令 `get` / `list` 默认读 effective config，传 `--scope user|project` 时展示对应层和 effective 值。project config root 在 git repo 或 workspace 内锚定仓库根；不在仓库内时退回 normalized command `cwd`。

动态 artifact 使用另一套 artifact render config，不能和读命令里的 effective config 混用。user scope artifact 只按 `default < user store` 渲染；project scope 的 repo-visible artifact 只按 `default < project shared store` 中可共享的键渲染。user store 和 project local store 可以影响 lifecycle/helper 的本机 effective config，但不能改变 project artifact 内容、digest、stale 判断或 refresh 结果。

`file` / `directory` 类型是本机路径型配置，只能写 user store 或 project local store。写入时，相对路径按 AW project root 解析，落盘为 canonical absolute realpath；每次读取 effective config 都会重新校验路径存在且类型正确。失效路径会进入 `invalid-config`，install/upgrade preflight、lifecycle context 和 helper 都会 fail closed。路径型配置不能进入 project shared config，也不能参与 project-scope repo-visible artifact 的 render config、digest、stale 判断或 refresh；需要可提交路径语义时，作者应改用可移植字符串配置。插件名作为 config store 路径段时只允许安全的单段名称，拒绝路径分隔符、`.`、`..`、绝对路径和 URL-like 值。

`scripts.helpers.config` 必须显式声明标准配置 helper。CLI 执行 lifecycle 或 `pnpm plugin:test` 时会通过 `AW_PLUGIN_CONTEXT` 传入已经解析好的 `config.values`、`config.sources` 和 schema；helper 没有 context 时，只读取当前 bundle 邻近的 `.agents-plugin/plugin.json` 来解释 schema/default/redaction。这意味着 helper 的 bundle 视图可能和 `aw config get/list` 的 current catalog 视图短暂不同，这是预期行为。

未声明 `config.schema` 的插件没有 AW 配置面：`aw config` 不会为它解释 raw store，status 也不会因为 “no schema” 生成需要处理的问题。未声明 `scripts.lifecycle` 的插件没有 install/upgrade/uninstall lifecycle，普通安装、升级、卸载、status 和 cleanup 都不能把“没有 lifecycle”视为异常；cleanup 收口残留时也不会运行 lifecycle。未声明 `artifacts.targets` 表示插件没有动态 artifact，静态 skills、slashCommands、extensions、MCP 或 hooks 仍按各自静态合同管理。

如果已安装的动态 artifact 声明了 `refreshKeys`，`aw config set` / `unset` / `reset` 写入后会按当前命令能定位到的 scope 自动刷新命中的 artifact。user config 写入会刷新 user target，并在当前 repo 也安装了 project target 时刷新当前 repo；project shared config 写入只刷新当前 repo project target。CLI 不扫描所有历史 project。刷新执行 renderer 时使用该 location 的 install record historical bundle，避免 current local marketplace 中的 runtime 文件覆盖模板源；historical bundle 缺失或校验失败时刷新失败并留下 diagnostic，由 `aw status --verbose` 或 JSON receipt 展示。dynamic diagnostic cache 会用 `refreshReach` 记录本次覆盖了 user、当前 project，还是有其它已知 project target 可能仍 stale。刷新失败不会回滚已经写入的 config store，但会把受影响 artifact 标记为最近 refresh failed，`aw status` 和 JSON receipt 会给出稳定诊断。

已安装位置的配置 schema 优先来自 install record 绑定的 historical runtime / manifest，而不是 current catalog。这样即使远程 catalog 不可用，已安装插件仍能读取和写入自己当时接受的 schema；如果同一个 config store 被多个 installed consumer 使用且 schema identity 不一致，`list/get/set/unset` 会因 `configSchemaConflict` 阻断。`config reset` 分两条路径：已消费 store 走 installed-aware write，receipt 稳定暴露 `removedKeys` 和 `artifactRefresh`，删除命中 `refreshKeys` 时会按 historical runtime 刷新动态 artifact；孤立残留 store 才允许用户确认后 raw 删除，不伪造 schema identity，也不刷新 artifact。

## Dynamic Artifacts

动态 artifact 适合“内容由配置决定，但写盘仍必须由 AW 管理”的场景。插件用 manifest 的 `artifacts.targets` 声明安装前能力真值，再用 `scripts.artifacts.render` 返回当前 scope 的 `ArtifactPlan`。安装、升级、交互式候选、project write safety preflight、status current catalog 和 install record artifact identity 都读取 `artifacts.targets`，不能等 renderer 执行后才推断插件能力。

首版动态 artifact target 只支持 Codex。声明 `artifacts.targets` 的插件必须支持 Codex，可以是 Codex-only，也可以是双平台插件中的 Codex target；Claude-only 插件声明动态 target 会在 manifest/build 校验时失败。

```json
{
  "skills": "./skills",
  "skillTriggers": {
    "codex-explore": {
      "defaultTrigger": "manual",
      "allowDynamicTrigger": true
    }
  },
  "artifacts": {
    "targets": [
      {
        "id": "codex-explore-skill",
        "platform": "codex",
        "scopes": ["user", "project"],
        "target": "codex.skill",
        "kind": "skill",
        "projectManagedKind": "skill",
        "states": ["present"],
        "refreshKeys": ["explorerModel", "modelReasoningEffort"],
        "skillKey": "codex-explore"
      }
    ]
  }
}
```

`ArtifactPlan` 顶层格式为 `{ "version": 1, "artifacts": [...] }`。每个 artifact 的关键字段：

- `id`：插件内稳定 id，只能使用安全字符；`pluginName + id + target` 是 AW 受管 artifact 的逻辑身份
- `target`：首版支持 `codex.skill`、`codex.developerInstructionsBlock` 和 `codex.agentRole`
- `state`：首版支持 `present` 和 `disabled`；当前 platform/scope 在 manifest 中声明过的动态 artifact 必须返回其中一种状态，不能省略
- `refreshKeys`：必须完整保留 manifest 中该 artifact 声明的 config key，且 key 必须存在于 `config.schema`
- `disabledReason`：`state = "disabled"` 时可写，例如 `config`；disabled artifact 可以没有 content，但仍要保留 `refreshKeys`

`codex.skill` 管理 Codex skill 目录。manifest target 必须静态声明 `skillKey`，用于安装前路径冲突检查、install record artifact identity、project artifact shared identity 和后续 stale prune；renderer plan 里的 `skillKey` 必须完全匹配。`present` content 是对象，必须包含 `skillFile`（写成运行时 `SKILL.md`）和 `openaiYaml`（写成运行时 `agents/openai.yaml`）。`SKILL.md` 是模型会读取的指令体；`agents/openai.yaml` 是 Codex 产品元数据和触发策略，`interface.default_prompt` 只放包含 `$skillKey` 的起手句。renderer 不能提供任意路径，也不能自己写 `.agents/skills/<skillKey>` 或用户级 Codex runtime。project scope 下它的 `projectManagedKind` 应声明为 `skill`，且不要求 `requiresCodexProjectConfig: true`，因为它不依赖 `.codex/config.toml`。

`codex.skill` 的内容真值来自“静态模板 + 当前 artifact render config + 当前 effective SkillTrigger 配置 patch”。插件通常把 `skills/<skillKey>/SKILL.md` 和 `skills/<skillKey>/agents/openai.yaml` 作为静态模板，由 renderer 读取模板并插入配置值；config refresh 时这些模板应来自 install record 的 historical bundle，而不是当前可变 runtime。AW apply 阶段再按 `defaultTrigger` 和用户写入的 `aw.skillTriggers.<skill>.trigger` effective 值 patch `openaiYaml`。`auto` 会让 Codex `policy.allow_implicit_invocation` 为 `true`，`manual` 会改为 `false`。重复 install、upgrade、reinstall 或 config refresh 不会因为 renderer 输出默认值而重置用户配置。

renderer plan 示例：

```json
{
  "version": 1,
  "artifacts": [
    {
      "id": "codex-explore-skill",
      "kind": "skill",
      "platform": "codex",
      "target": "codex.skill",
      "state": "present",
      "skillKey": "codex-explore",
      "refreshKeys": ["explorerModel", "modelReasoningEffort"],
      "content": {
        "skillFile": "---\nname: codex-explore\n---\n# Codex Explore\n",
        "openaiYaml": "policy:\n  allow_implicit_invocation: true\n"
      }
    }
  ]
}
```

`codex.developerInstructionsBlock` 写入当前 scope 对应 Codex config 的 AW managed developer instructions block。`present` 需要 `content` 字符串；`disabled` 会移除或跳过该 artifact 对应的受管 instruction，不保留“已禁用”的运行时提示词。project scope 下它的 `projectManagedKind` 应声明为 `instruction`。

`codex.agentRole` 管理 Codex agent role 注册项和 role layer 文件。manifest target 必须静态声明 `roleKey`，用于安装前 role namespace 冲突检查；renderer plan 里的 `roleKey` 必须完全匹配。`present` content 包含 `registration.description` 和 `roleFile`；`registration.config_file` 由 AW 生成，renderer 不能提供。`roleFile.name` 必须等于 `roleKey`，可包含 Codex-only 的 `model` 和 `model_reasoning_effort`。project scope 下它的 `projectManagedKind` 应声明为 `agent`，不要把内部 `kind = "codexRole"` 写入 install record artifact identity。

动态 `codex.skill` 适合配置驱动的 skill。不要用 lifecycle 直接改 `.agents/skills/**`、`~/.codex/**` 或 `~/.aw/plugins/**` 来“刷新 skill”；那会绕过 install record、trigger preference、diagnostic cache，以及 `aw status --verbose`、`aw cleanup`、`aw reinstall` 和 uninstall/stale prune 依赖的状态链路。固定不随配置变化的 skill 仍放在 `skills/` 静态目录即可。

> P0/P11 runtime contract：`codex-explore` 以 `codex.skill` 形态发布通用只读探索 workflow。它可以覆盖代码库、文档、网络资料、日志和用户材料；公开文档和 release 说明需要同时写清，具体来源访问取决于当前会话工具、权限、联网策略和用户提供的上下文。

静态 `extensions.*` 仍然适合不依赖 AW config 动态切换的简单产物，例如固定 instructions、permissions、hooks、native hooks 或 agent 文件。已有静态插件不需要迁移到 renderer；只有当产物内容、启用状态或 role 注册需要随 AW config 刷新时，才应使用动态 artifact。

## Plugin Script Tests

插件脚本测试是开发期包脚本：

```bash
pnpm plugin:test <plugin>
pnpm plugin:test <plugin> --platform codex --scope project
pnpm plugin:test <dual-platform-plugin> --platform both --scope project
pnpm plugin:test --all
```

它不会暴露为 `aw` 客户端子命令。runner 会先用 staging 模式准备临时 bundle，并从 build 后 staging manifest 解析最终支持平台。省略 `--platform` 时按 `both` 处理；`--platform auto` 无效并会失败；显式 `claude` 或 `codex` 遇到任一选中插件不支持该平台时会在测试执行前失败；`both` 按每个插件最终支持平台集合展开，单平台插件只跑自己支持的平台，双平台插件分别跑 Codex 和 Claude 两轮。

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
- **Codex 指令正文**：来自 `SKILL.md`。`agents/openai.yaml.interface.default_prompt` 只是 UI/客户端默认起手句，应包含 `$skill-name`，不要承载完整触发规则
- **Claude 用户手动触发**：取决于 `SKILL.md` frontmatter 的 `user-invocable`
- **Claude 模型自动调用**：取决于 `SKILL.md` frontmatter 的 `disable-model-invocation`

`.agents-plugin/plugin.json` 里的 `skillTriggers` 为显式受管 skill 定义默认触发策略，以及用户是否可以通过 AW 配置动态修改。例如：

```json
{
  "skills": "./skills",
  "skillTriggers": {
    "commit": {
      "defaultTrigger": "manual",
      "allowDynamicTrigger": true
    }
  }
}
```

`defaultTrigger` 只允许 `manual` 或 `auto`。`manual` 禁止模型自动触发但保留显式调用入口；`auto` 允许模型自动触发。`allowDynamicTrigger: true` 表示用户可以通过 `aw config set <plugin> aw.skillTriggers.<skill>.trigger manual|auto` 或主控制台配置页修改该 skill；`allowDynamicTrigger: false` 表示字段固定只读，effective 值永远等于 `defaultTrigger`。旧的安装期覆盖字段不再是有效合同，新 manifest 中不能继续使用。

静态 `skills/<skill>` 子目录和动态 `artifacts.targets[].target = "codex.skill"` 的 `skillKey` 必须有 `skillTriggers.<skill>` entry。公共 `slashCommands` 在 Codex 侧生成的 manual-only skill 不要求作者补 entry；AW 会注入 `defaultTrigger: "manual"`、`allowDynamicTrigger: false` 的 fixed built-in 字段。SkillTrigger 内建配置存储在 AW 保留 namespace `$aw.skillTriggers` 下，不进入插件作者的普通 `config.schema`，JSON 读命令会把字段标记为 `kind: "builtIn"`、`reserved: true`。

详见 `.agents/skills/create-agent-workflows-plugin/references/skills-and-triggers.md`。

## Scope Semantics

- **Claude**：`project` 和 `user` scope 都完整支持，settings 层别区分
- **Codex user scope**：使用 native plugin / marketplace 平面。AW 通过 `codex plugin marketplace add/list/remove` 管理本地 marketplace，通过 `codex plugin add/remove` 完成安装或卸载，并在写后校验 enabled config 与 active cache。`codex app-server` 的 `plugin/list`、`plugin/installed`、`plugin/read` 只用于 verbose/native view 只读诊断。作者不能依赖“只写 config”或 app-server 写入主链路的旧行为。
- **Codex project scope**：不启用 user native plugin，不写用户级 `[marketplaces]` 或 `[plugins]`，也不调用 Codex native CLI / app-server；只写当前仓库 `.agents/skills`、`.codex/config.toml`、`.codex/hooks.json`、`.codex/rules/`、`.codex/agents/` 和 `.agent-workflows/project-artifacts/`。写入前仍要求本机 Codex `>= 0.144.0`，通过门禁后不能产生用户级 native 副作用。
- **Apps 与 Codex project installability**：`apps` 是 Codex 能力，`products=["CLAUDE"] + apps` 是矛盾配置，会在 manifest/build 校验时失败。包含 `apps` 的 Codex 插件在 project scope 会 fail fast；纯 native-only 插件也不能以 project scope 安装。面向项目安装的插件至少要提供 repo-visible surface，例如 skills、MCP、slashCommands、instructions、permissions、hooks、nativeHooks 或 agents。
- **Project key**：Claude project scope 以当前工作目录的真实路径为 key；Codex project scope 会先解析仓库根目录，再以真实路径为 key。
- **共享 runtime owner**：`~/.aw` 对同一用户共享。Codex user scope 和 Claude native runtime 的同一 plugin/platform 同时只有一个 owner 可以控制 shared skill trigger runtime；owner 冲突只作为写命令 blocker、diagnostic 或状态详情展示。用户需要卸载、cleanup 或调整 owner 对应的有效安装后重试原写命令。Codex project scope 不参与 shared runtime owner 合同，只改当前仓库 repo skill。
- **Project artifact identity**：project scope 会维护 `.agent-workflows/project-artifacts/<platform>/<sharedIdentityId>.json`。它是可提交的共享身份线索，不能保存本机绝对路径、`projectKey` 或 record id；fresh clone 后通过它和 repo-visible artifacts 进入“可认领”状态。`kind: "skill"` 和 `kind: "mcpServer"` 必须写 `artifactKey`。MCP `artifactKey` 使用 rendered `.mcp.json` 的原始 server key，包含点号、空格或 Unicode 时仍按 TOML quoted key 写入 `.codex/config.toml`，例如 `[mcp_servers."acme.tools v1"]`。

Codex user native 安装失败时，作者和用户会在 `aw status --json` 里看到更细的诊断：`native.pluginInstalled` 表示 cache installed，`native.pluginEnabled` 表示 config enabled，native transaction marker 表示 native 写入已发生但 AW record 尚未提交。插件 lifecycle 应保持幂等，因为 Codex CLI 写入成功后如果 lifecycle、artifact apply、diagnostic cache 或 record commit 失败，用户可能重试同一条 `aw install`，或在状态进入 `cleanupRequired` 后运行 cleanup 收口；marker-only cleanup 不会运行 uninstall lifecycle。
