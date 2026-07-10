---
name: create-agent-workflows-plugin
description: 当用户明确要在 `agent-workflows` 仓库新增或维护 `plugins/<name>/` 插件项目时使用；涵盖 manifest 编写、能力选择与配置、extensions、buildConfig、公共 slashCommands、MCP/Apps 集成、Claude 专属能力和 bundle 校验。
disable-model-invocation: true
---

# Create Agent Workflows Plugin

在当前仓库创建或维护 agent-workflows 插件。插件默认同时支持 Codex 和 Claude Code，也可以通过 `marketplace.policy.products` 收窄到单个平台。这里描述的是源码层公共 contract，不是 Claude Code / Codex 原生插件 schema 的全集。插件作者只需维护 `plugins/<name>/` 下的源码文件；运行时 bundle、catalog manifest 和本地 runtime 视图由 CLI / 发布流程自动生成。

## 快速开始

按你要创建的插件类型，选择最短阅读路径。所有插件都必须有 `.agents-plugin/plugin.json`；如果包含面向 Codex 的 skill，还需要对应的 `SKILL.md` 和 `agents/openai.yaml`。

### 场景 A：纯 Skill 插件（最常见）

只提供一个可调用的工作流，无额外规则注入。

```text
plugins/<name>/
├── .agents-plugin/plugin.json
└── skills/<skill-name>/
    ├── SKILL.md
    └── agents/openai.yaml          # 面向 Codex 时必需；Claude-only skill 可省略
```

**先读**：`references/plugin-manifest-spec.md` → `references/skills-and-triggers.md`

### 场景 B：纯 Extensions 插件

只注入规则、权限、hooks 或 agents，无 skill。

```text
plugins/<name>/
└── .agents-plugin/plugin.json        # extensions 声明在 manifest 内
```

**先读**：`references/plugin-manifest-spec.md` → `references/extensions-spec.md`

### 场景 C：混合型 / 公共 slashCommands / Claude 专属能力

包含 skill + MCP + 公共 slashCommands + output styles 等多种能力，或需要 `buildConfig`。

```text
plugins/<name>/
├── .agents-plugin/plugin.json
├── skills/<skill-name>/
│   ├── SKILL.md
│   └── agents/openai.yaml          # 面向 Codex 时必需；Claude-only skill 可省略
├── .mcp.json
├── slash-commands/
│   └── *.md
└── output-styles/
    └── *.md
```

**先读**：场景 A 或 B 的路径 + `references/mcp-and-apps.md` + `references/build-config-spec.md` + `references/slash-commands.md` + `references/claude-only-capabilities.md`

### 场景 D：带 AW Config / Lifecycle / 脚本测试的插件

插件需要安装初始化、卸载清理、跨 Claude/Codex 共享配置，或需要为配置 helper/lifecycle 写 Node 测试时使用。

```text
plugins/<name>/
├── .agents-plugin/plugin.json
└── scripts/
    ├── aw-config.mjs
    ├── lifecycle.mjs
    └── *.test.mjs
```

**先读**：`references/aw-scripts-config-lifecycle.md` → `references/plugin-manifest-spec.md` 的 `scripts / config block`。可用脚手架 `--with-config-api` / `--with-lifecycle` 生成样板。

### 场景 E：Codex 动态 Artifact 插件

插件需要根据 AW config 动态生成 Codex skill、developer instructions 或 agent role，并在 `aw config set/unset/reset` 或主控制台配置向导保存后自动刷新。配置驱动的 Codex skill 优先使用 `codex.skill`，不要用 lifecycle 直接改 `.agents/skills/**` 或用户级 Codex runtime。

```text
plugins/<name>/
├── .agents-plugin/plugin.json      # scripts.artifacts.render + artifacts.targets
└── scripts/
    └── render-artifacts.mjs        # stdout 输出 ArtifactPlan JSON
```

**先读**：`references/plugin-manifest-spec.md` 的 `artifacts.targets` → `references/aw-scripts-config-lifecycle.md` 的动态 Artifact Renderer → `references/extensions-spec.md` 的静态 / 动态边界。

## 能力速查

| 能力 | 平台 | 配置位置 | 细节 |
|------|------|----------|------|
| Skills | 默认双平台，可收窄 | `skills/`、`SKILL.md`、`agents/openai.yaml` | `references/skills-and-triggers.md` |
| Extensions | 默认双平台，可收窄 | `extensions.instructions` / `permissions` / `hooks` / `nativeHooks` / `agents` | `references/extensions-spec.md` |
| Dynamic Artifacts | Codex | `artifacts.targets`、`scripts.artifacts.render` | `references/plugin-manifest-spec.md`、`references/aw-scripts-config-lifecycle.md` |
| MCP Servers | 默认双平台，可收窄 | `.mcp.json` + manifest `mcpServers` | `references/mcp-and-apps.md` |
| Apps | Codex | `.app.json` + manifest `apps` | `references/mcp-and-apps.md` |
| Public Slash Commands | 默认双平台，可收窄 | `slashCommands`、`slash-commands/`、`slash-commands/assets/` | `references/slash-commands.md` |
| Claude 专属能力 | Claude | `output-styles/`、`buildConfig.manifestOverrides.claude` | `references/claude-only-capabilities.md` |
| Build Config | 支持平台 | `buildConfig.templates` / `fileRules` / `manifestOverrides` | `references/build-config-spec.md` |
| AW Scripts / Config / Lifecycle | 支持平台 | `scripts` / `config`、`scripts/aw-config.mjs`、`scripts/lifecycle.mjs`、`scripts/**/*.test.mjs` | `references/aw-scripts-config-lifecycle.md` |
| Plugin Dependencies | 支持平台 | `.agents-plugin/plugin.json` 顶层 `dependencies.plugins` | `references/plugin-manifest-spec.md` |

插件不需要包含所有能力；先按场景选组合，再打开对应参考文档补字段细节。

## 创建工作流

1. **确认命名**：插件名使用小写短横线格式（如 `code-review`），必须与目录名一致。
2. **选择能力组合**：参考上方场景和能力速查，确定需要哪些能力。
3. **脚手架**（可选）：新建插件先跑 `scripts/init_plugin.js`（见下方）；维护已有插件先读 `.agents-plugin/plugin.json`。
4. **编辑 manifest**：按需补齐 `.agents-plugin/plugin.json` 字段。字段规范见 `references/plugin-manifest-spec.md`。
5. **实现各能力**：
   - Skills → 编写 `SKILL.md`；面向 Codex 的 skill 同时提供 `agents/openai.yaml`，配置产品元数据和触发策略
   - Extensions → 在 manifest 的 `extensions` 中声明
   - MCP/Apps → 创建 `.mcp.json` / `.app.json`
   - Public slashCommands → 创建 `slash-commands/*.md`；Claude 生成原生 `/command`，Codex 生成 manual-only skill，图标只能引用 `./assets/...`
   - Claude 专属 → 创建对应目录 + 配置 `buildConfig`
   - AW Config / Lifecycle → 先读 `references/aw-scripts-config-lifecycle.md`，再在 manifest 声明 `config.schema`、`scripts.helpers.config`、`scripts.lifecycle` 和 `scripts.tests.node`
   - Dynamic Artifacts → 在 manifest 声明 `artifacts.targets` 和 `scripts.artifacts.render`；配置驱动的 Codex skill 用 `codex.skill` + 静态 `skillKey`；renderer 只输出 `ArtifactPlan`，不要直接写 `.agents/skills/**`、Codex user runtime、`.codex/config.toml`、`.codex/agents/*.toml`、project artifact identity、diagnostic cache 或 install record；config refresh 会从 install record 的 historical bundle 执行 renderer，Codex user dynamic skill 的 native cache 重建也会 staging historical bundle 后叠加本次刷新结果，不要依赖当前 local marketplace 中可变的 runtime 文件作为模板真值
   - Plugin Dependencies → 在 manifest 顶层声明 `dependencies.plugins`；依赖只指向当前 AW catalog 内其它插件；需要版本约束时只写 `minVersion`，不写 range、外部来源或 platform override
6. **构建**：运行 `pnpm build` 生成本地 staging/runtime bundle。CLI tarball 不再把插件快照作为 embedded fallback 发布；正式分发由 catalog sidecar/full 包承载。
7. **验证**：运行 `scripts/validate_plugin.js` 校验插件结构。构建后会复用 CLI 的权威源码 contract 校验；未构建时只做轻量预检，预检通过不代表完整 contract 通过。`SKILL.md` frontmatter、TODO 占位和 `agents/openai.yaml` schema 仍属于作者工具体验检查。
8. **测试**：插件内 Node 脚本用 `pnpm plugin:test <plugin>`；改到 manifest、bundle 或安装逻辑时，再运行相关 `pnpm test:*`。

### Codex scope 提醒

- Codex `--scope user` 使用 native plugin 平面。AW 会用 `codex plugin marketplace add/list/remove` 管理本地 marketplace，并通过 `codex plugin add/remove` 写入 native plugin；`codex app-server` 只用于 verbose/native view 只读诊断。不要再按“只写 `[plugins."<plugin>@aw"]`”或 app-server 写入主链路理解安装结果。`aw status` 只有在 enabled config、active materialized cache 和 AW per-plugin record 都健康时才把它投影为 `installed`；enabled-only、cache-only 或 native transaction 残留只会作为 diagnostics、command blocker 或 `cleanupRequired` 细节展示。
- Codex `--scope project` 只写当前仓库 repo-managed artifacts，不调用 native marketplace CLI 或 app-server RPC，也不会改用户级 config/cache；但写入前仍要求本机 Codex `>= 0.144.0`。
- 面向 Codex project 的插件必须有 repo-managed surface。纯 native-only 插件不能 project 安装；包含 `apps` 的插件 project scope 会 fail fast，请引导用户使用 `--scope user` 或拆分插件。
- 带 lifecycle 的插件要保持幂等：Codex user native CLI 写入成功后如果 AW 后续步骤失败，用户可能重试同一条 install，或在状态进入 `cleanupRequired` 后运行 cleanup 收口；只有 verified install record 引用的 historical lifecycle runtime 才能驱动普通 uninstall lifecycle，cleanup 不运行 lifecycle。没有声明 lifecycle 只是表示插件没有安装/卸载脚本，不是 status 问题。

### CLI 入口与输出合同

- `aw` 主命令是唯一交互入口；TTY 下进入插件控制台，配置向导也只在这里出现。脚本和文档示例不要再使用子命令交互 flag。
- 脚本化配置入口是 `aw config set`、`aw config unset` 和 `aw config reset`。读配置用 `aw config list/get`。所有这些命令都可以配合 `--json` 做机器消费。`aw uninstall --remove-config` 和 `aw cleanup --remove-config` 只在主体成功后顺手删除当前 target 的 AW config store；单独清配置仍用 `aw config reset`。
- `aw install`、显式 `aw upgrade` 和 `aw upgrade --all` 会自动解析并安装/升级缺失依赖；`aw uninstall` 会保护仍被依赖的插件，并在父插件卸载后清理引用归零的自动依赖。文档和示例里不要要求用户手动按顺序安装普通依赖，除非该依赖需要用户先单独配置或选择特殊安装选项。
- `aw init` 现在只预热远程 catalog 和 artifact cache。它不安装插件、不升级插件、不写 install record，也不 materialize active local marketplace/runtime view。需要 user-scope native runtime 的写命令会在调用平台 native 能力前按本次 current catalog materialize 并校验 active view。
- 旧恢复命令已移除，不再作为公开入口。project fresh clone 的共享产物认领入口是 `aw install <plugin> -p <platform> -s project --adopt-existing`；异常状态和 AW-owned 残留用 `aw cleanup`；按 current catalog 删除后重建用 `aw reinstall`；dependency index stale reference 只用 `aw cleanup --dependency-index --prune-stale <token> --yes`。
- `init/install/uninstall/upgrade/config set/unset/reset --json` 的 stdout 是单一 JSON receipt，最小公共字段为 `ok`、`command`、`warnings`、`nextSteps`；写命令会按能力补充 `plugins`、`targets`、`actions`、`artifacts`、`native`、`artifactRefresh` 等字段。
- 默认输出只展示用户能理解的完成状态和下一步；内部诊断放到 `--verbose`、`--debug` 和 JSON 中。插件文档不要要求用户从默认输出里解析 marketplace、RPC、cache、native transaction、install record、diagnostic cache、project artifact identity、healthSource 或 config/script health 等内部词。
- `aw status` 默认输出使用友好状态投影；`aw status --json` 暴露稳定机器字段、`statusSchemaVersion: 2`、`consoleItemsSchemaVersion: 3`、`consoleItems.features` 和每个位置的 `dependencies` 投影。未声明 config、lifecycle 或动态 artifact target 不会被投影成默认问题。`aw status --verbose` 可展示诊断字段，但 status 仍是只读命令，不运行 renderer、lifecycle、配置刷新、恢复动作或依赖自动清理。

## 脚手架脚本

```bash
node .agents/skills/create-agent-workflows-plugin/scripts/init_plugin.js <plugin-name> \
  --description "插件描述" \
  --display-name "Display Name" \
  --short-description "简短描述" \
  [--skill-name <name>] \
  [--skill-description "skill 描述"] \
  [--no-skills] \
  [--with-mcp] \
  [--with-apps] \
  [--with-config-api] \
  [--with-lifecycle] \
  [--version 0.1.0] \
  [--min-version 0.0.0] \
  [--catalog-min-version 0.0.0] \
  [--repo-root .]
```

- 默认创建带 skill 的插件骨架
- `--display-name` / `--short-description` 只写入插件级 `interface`；初始 skill 的 Codex 展示名默认由 `--skill-name` 推导，展示简述优先使用 `--skill-description`
- `--no-skills`：创建不含 skill 的插件（不需要 `--skill-name` 和 `--skill-description`）
- `--with-mcp` / `--with-apps`：创建 `.mcp.json` / `.app.json` 存根；细节见 `references/mcp-and-apps.md`
- `--with-config-api`：添加 AW 自管 `config.schema`、标准 `scripts.helpers.config` helper 和 Node 脚本测试样板
- `--with-lifecycle`：添加 Node lifecycle 样板和 Node 脚本测试样板
- `--min-version`：写入插件 manifest 的 `compatibility.aw.minVersion`；不传时默认跟随 `--catalog-min-version`，两者都不传时默认 `0.0.0`
- `--catalog-min-version`：提供目标 catalog 的 `compatibility.aw.minVersion` 作为作者工具校验上下文；插件 `compatibility.aw.minVersion` 不能高于这个门槛
- 默认省略 `marketplace.policy.products`，让插件保持双平台；声明后该字段会同时约束 build 裁剪、平台 marketplace、安装/升级门禁和 `pnpm plugin:test` 平台选择
- 带静态 `skills/<skill>` 或动态 `codex.skill` 的插件必须在 `skillTriggers.<skill>` 声明 `defaultTrigger` 和 `allowDynamicTrigger`；公共 `slashCommands` 生成的 Codex manual-only skill 不需要作者补 entry
- 不改 `plugins/marketplace-source.json`，不生成平台 manifest

## 最小检查

- `.agents-plugin/plugin.json` 是唯一手动维护的 manifest；不要手写 `.claude-plugin/plugin.json` 或 `.codex-plugin/plugin.json`。
- `version` 和 `compatibility.aw.minVersion` 都必须是严格 SemVer。CLI version、catalog version 和 plugin version 是三套身份；插件升级不要求 CLI 发版，但修改 runtime、依赖最低版本、最低 CLI 版本或平台能力时必须发布新的插件 `version`。
- 不要在 manifest 中声明最低 Codex 或 Claude Code 版本字段；AW CLI 内置宿主门槛，当前是 Codex `>= 0.144.0`、Claude Code `>= 2.1.88`。
- 发布到 `latest` catalog 的插件 `version` 必须是 stable SemVer；prerelease 插件只能进入 `beta` catalog。`beta` catalog version 必须是 prerelease，且可以混合 stable / prerelease 插件 version；同一个 catalog version 不能跨轨道复用。
- `dependencies.plugins` 只允许 `name`、`minVersion`、`target`、`inheritInstallOptions`、`when`。`minVersion` 是严格 SemVer 最低依赖版本；`when.platforms` 只能写 `codex` / `claude`，`target.scope` 只能写 `user` / `project`；不要写旧式 `version`、`range`、`marketplace`、`source`、`optional`、`dev`、`peer`、`platform` 或 `target.platform`。
- 依赖字段只保留在 source/runtime `.agents-plugin/plugin.json`；平台原生 manifest 和 marketplace manifest 不包含 `dependencies`。
- `@yiliang/aw-plugins-manifest` sidecar 包只包含 `catalog-manifest.json` 和必要 package metadata，用于兼容性、history 和 digest 判断；`@yiliang/aw-plugins` full catalog 包包含同一份 manifest 和当前 catalog 单版本快照的全部插件 artifact；history 只记录已发布版本和 digest，不是可直接安装的多版本索引。
- user scope 父插件不能依赖 project scope 插件；project scope 父插件省略 `target.scope` 时优先当前 project，必要时可复用健康 user scope。显式 `target.scope` 时按声明固定选址。
- `skills`、`mcpServers`、`apps` 只能写单个 `./` 开头的路径，且声明的路径必须存在。
- 所有插件在 bundle 中都会保留 `.agents-plugin/plugin.json`；`.claude-plugin/`、`.codex-plugin/`、`claude/`、`codex/` 只在支持平台存在。
- `apps` 是 Codex 能力，`products=["CLAUDE"] + apps` 是矛盾配置。
- 手动触发命令只使用公共 `slashCommands`。
- `slashCommands` 只为支持平台生成 Claude commands / Codex manual-only skills；Codex 结果固定 manual-only，不能配置 `codex.policy`；Codex 图标资源只能来自 `slash-commands/assets/` 并写成 `./assets/...`。
- `plugins/marketplace-source.json` 通常不随单个插件改动；catalog staging 产物、`packages/cli/plugins-dist/` 和 `~/.aw/` 都是生成或运行时目录，不手改。
- 面向 Codex 的 skill 必须带 `agents/openai.yaml`，并显式写出 `policy.allow_implicit_invocation`。`SKILL.md` 才是模型指令体；`openai.yaml.interface.default_prompt` 只是 UI/客户端起手句，若填写必须包含 `$skill-name`，不要把详细触发规则放进去。
- Codex 动态 artifact 要求插件支持 Codex；可以是 Codex-only，也可以是双平台插件中的 Codex target。配置驱动 skill 推荐声明 `target: "codex.skill"`、`projectManagedKind: "skill"` 和静态 `skillKey`；renderer plan / fixture 里的 `skillKey` 必须与之完全一致。`codex.agentRole` target 必须静态声明合法 `roleKey`，renderer plan / fixture 里的 `roleKey` 必须与之完全一致。
- Unsupported platform 的 `buildConfig.fileRules`、`manifestOverrides`、`extensions.nativeHooks` 和非空 `agentOverrides` 会 fail fast；`agentOverrides.<unsupportedPlatform> = null` 合法，表示显式排除。
- `artifacts.targets` 是安装前能力真值；`scripts.artifacts.render` 只在 install / upgrade / config refresh / refresh-only 写路径执行，`aw status` 不执行 renderer。
- `codex.skill` 的 runtime 内容来自静态模板、artifact render config 和当前 effective SkillTrigger built-in config patch。`auto` 会让 Codex `policy.allow_implicit_invocation` 为 `true`，`manual` 会改为 `false`；config refresh 和重新应用配置不应重置用户配置。
- dynamic artifact 的 accepted state、digest 和最近 refresh 摘要保存在 dynamic diagnostic cache，不进入 install record。刷新失败、drift 或 missing 会通过友好状态投影给出下一步；disabled by config 不是故障。refresh-only 动作只重新应用已有配置，不改 config store。
- project shared config 写 `.agent-workflows/plugin-config/<plugin>/config.json`，是 repo-visible project artifacts 唯一共享配置输入；project local config 写 `.agent-workflows/plugin-config.local/<plugin>/config.json`，默认忽略，只影响本机 effective config、lifecycle 和 helper。
- project scope 的 private state / local config 默认应被 ignore；`.agent-workflows/plugin-config/` 和 `.agent-workflows/project-artifacts/` 是可提交的共享输入/identity，模板和示例不要默认忽略它们。
- `file` / `directory` 类型配置只适合 user 或 project local 的本机 effective config；project shared config、project artifact render config、dynamic artifact `refreshKeys` 和 repo-visible artifact truth 不能依赖这类 realpath 值。
- 写动作必须来自明确的 location target。插件出现在多个位置时，控制台和脚本 receipt 可以汇总状态，但不能把“多个位置”当成隐式批量写目标；执行安装、升级、卸载、配置、refresh-only 或 cleanup 前都要明确 platform/scope/project 位置。
- 改到 manifest、bundle 或安装逻辑时，先跑 `pnpm build`，再跑相关 `pnpm test:*`。
- 插件内 Node 脚本测试通过仓库包脚本 `pnpm plugin:test <plugin>` 运行，不通过 `aw` 客户端子命令。
- lifecycle 支持 Node 和受控 shell 文件，不支持内联 shell 命令；Windows 优先写 Node 入口，或单独提供 `.ps1` / `.cmd`。
- Node lifecycle/helper/test 默认只能使用 `node:` 内置模块和插件内相对 import。需要第三方依赖时声明 `scripts.node.packageRoot`，提交 `package.json` 和 `pnpm-lock.yaml`，并只使用 registry-backed 依赖；运行时依赖离线随 bundle 携带。
- manifest build 只能通过 `scripts.node.build` 显式触发，并运行在隔离 staging 目录；不要期待 `package.json` scripts 或 npm lifecycle 自动执行，也不要依赖源码树被回写。
- Codex user native 成功状态需要 enabled config、active materialized cache、native transaction 状态和 AW per-plugin record 同时健康；`aw status --json` 中 `native.pluginInstalled` 表示 cache installed，`native.pluginEnabled` 表示 config enabled，native transaction marker 残留会投影为需要处理而不是普通已安装。
- P0/P11 runtime contract：`$codex-explore` 可描述为通用只读探索 workflow，覆盖代码库、文档、网络、日志和用户材料；同时必须说明访问来源受当前会话工具、权限、联网策略和用户提供的上下文限制，不能承诺当前会话不可访问的来源。

## 脚本测试入口

```bash
pnpm plugin:test <plugin>
pnpm plugin:test <plugin> --platform codex --scope project
pnpm plugin:test <dual-platform-plugin> --platform both --scope project
pnpm plugin:test --all
```

`pnpm plugin:test` 会先编译 CLI，再运行已编译 runner。它会先准备 staging source，并用 build 后 staging manifest 的 `products` 解析最终支持平台；省略 `--platform` 时按 `both` 处理，`--platform auto` 无效并会失败。显式 `claude` / `codex` 遇到任一选中插件不支持该平台时，runner 会在测试执行前失败；`both` 按每个插件最终支持平台集合展开，单平台插件只跑自己支持的平台，双平台插件分 Codex/Claude 两轮复制独立可写 bundle。runner 会为目标插件准备临时 bundle、隔离 `AW_HOME` 和受管临时 project root，然后执行 `scripts.tests.node` 匹配到的 Node 测试。没有匹配测试时是 skipped/no-op，退出码为 0；单插件模式不会被其它插件的坏 manifest 或测试失败阻断。测试中的 `AW_PLUGIN_CONTEXT.sourceRoot` 指向原始源码根，适合读取源码 fixture；实际运行时入口和 helper 应从临时 bundle import。更完整的 context、helper 和 config store 规则见 `references/aw-scripts-config-lifecycle.md`。

更细的能力矩阵、平台差异、命令结果填充和长 checklist 都在下方参考文档里，按场景加载即可。

## 参考文档索引

| 文档 | 覆盖范围 |
|------|---------|
| `references/plugin-manifest-spec.md` | plugin.json 完整字段规范、marketplace、interface、三层分发模型 |
| `references/skills-and-triggers.md` | Skills 目录结构、SKILL.md 规范、命令结果填充、agents/openai.yaml、双平台触发配置 |
| `references/extensions-spec.md` | instructions / permissions / 公共 hooks / nativeHooks / agents + agentOverrides 机制 |
| `references/build-config-spec.md` | templates 模板渲染 / fileRules 平台文件规则 / manifestOverrides 覆盖 |
| `references/mcp-and-apps.md` | .mcp.json 和 .app.json 配置格式与平台行为 |
| `references/slash-commands.md` | 公共 slashCommands 源码格式、分平台 frontmatter、生成产物和限制 |
| `references/aw-scripts-config-lifecycle.md` | AW config CLI、标准 config helper、lifecycle context、脚本测试和排障 |
| `references/claude-only-capabilities.md` | Claude 命令结果填充 / output-styles / lspServers / userConfig / channels |
| `references/comprehensive-example.md` | 综合示例说明 + 构建产物预览 |
| `references/.examples/code-review/` | 可直接读取的完整示例插件目录（隐藏父目录用于避免被 Codex 当作 repo skill） |

## 现有样例

- `references/.examples/code-review/`：覆盖 skills、slashCommands、extensions、MCP、output-styles、buildConfig、AW config、lifecycle 和 plugin:test 的完整示例插件目录。这里故意把样例放在隐藏父目录下，避免 Codex 递归扫描到示例里的 `SKILL.md` 并把它当成当前仓库的真实 skill
