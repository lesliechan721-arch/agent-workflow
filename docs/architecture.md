# Architecture

## CLI Source Layout (`packages/cli/src`)

- **`commands/`** — 编排主控制台以及 `init`、`install`、`uninstall`、`upgrade`、`config`、`status`、`repair`、`cleanup`、`reinstall`；`console.ts` 负责 `aw` 主交互入口，`console-model.ts` 生成公开 `PluginConsoleSummary`、控制台页面模型和执行层 action 类型，`status.ts` 提供 `status --json.consoleItems` V3 与 console 专用 loader，`options.ts` 统一归一化命令参数，`runtime.ts` 统一注入 env、native runner、prompt、reporter 和 debug logger，`discovery.ts` 枚举受管、可认领或可发现插件，`common.ts` 放平台选择、catalog 准备和共享状态格式化逻辑
- **`adapters/`** — `claude.ts` / `codex.ts` 处理平台原生状态与命令调用；`helpers.ts` 放共享 adapter 逻辑；`types.ts` 放 adapter 层私有类型
- **`generators/`** — `instructions.ts` / `permissions.ts` / `hooks.ts` / `agents.ts` 分别生成对应产物；`local-plugin.ts` 处理 bundle 和 repo-visible 文件生成；`shared.ts` 放跨生成器共享逻辑
- **`output/`** — `command-receipt.ts` 构造写命令 JSON receipt 和默认人类 renderer；`reporter.ts` 负责 stdout/stderr 的 notices、warnings 和 verbose 诊断渲染；`debug-log.ts` 负责调试日志落盘、轮转和失败提示；`redact.ts` 统一脱敏 token、password、authorization、cookie 等敏感字段
- **`utils/`** — `manifest.ts` 解析 plugin manifest；`slash-commands.ts` 解析公共 `slashCommands` 并生成 Claude commands / Codex manual-only skills；`marketplace.ts` / `local-marketplace.ts` 处理本机 runtime、catalog cache 和 active view；`plugin-catalog.ts` 做 sidecar/full catalog 解析、selector 归一化、history 兼容查询，以及身份确认后的 cache 快路径和 fallback；`plugin-dependency-location.ts`、`plugin-dependency-graph.ts` 和 `plugin-dependency-planner.ts` 统一处理插件依赖的 location 身份、最低版本、拓扑规划、卸载保护和 status 只读投影；`plugin-config.ts` 管理 AW 自管配置 store、schema source/identity 校验、内建 SkillTrigger 字段和 install/upgrade preflight；`plugin-config-write.ts` 提供共享 config write helper、`config reset` 分支和 built-in apply pipeline；`plugin-scripts.ts` 管理 lifecycle target、context 和 runner；`artifact-renderer.ts` 执行动态 artifact renderer并解析 artifact render config；`artifact-plan.ts` 校验 `ArtifactPlan` 并计算 digest；`artifact-refresh.ts` 处理 config-triggered refresh 和 refresh-only 重试动作；`codex-skill-staging.ts` 生成动态 `codex.skill` expected tree 并应用 trigger patch；`plugin-script-contract.ts` 扫描 Node import contract；`generated-artifacts.ts` 管理生成产物与回滚；`bundle-layout.ts` 校验构建后 bundle 与 catalog artifact 布局；`codex-config.ts` 做 Codex 配置 round-trip；`codex-app-server-client.ts` 封装 Codex app-server 插件 RPC；`codex-native-state.ts` 只读检查 Codex enabled config 和 materialized cache；`skill-trigger-preferences.ts` 处理 manifest 默认策略、AW 内建配置 effective 值和 runtime apply 输入；`paths.ts` / `detect.ts` / `file-rules.ts` 等放底层辅助
- **`install-state/`** — 新安装状态 facade，集中读写 per-plugin install record v2、dynamic diagnostic cache、project artifact identity、dependency index、historical lifecycle runtime、native transaction marker 和 shared runtime owner；命令、adapter、status 和控制台都通过它收集证据、提交事务和生成状态投影
- **`constants.ts`** — 全局常量：`GENERATED_FILE_PREFIX = 'aw-'`、`TRACKING_MANIFEST_FILE = '.agent-workflows-manifest.json'`、`DEFAULT_CLAUDE_HOOKS_PATH`、`CLAUDE_MARKETPLACE_PATH`、`CODEX_MARKETPLACE_PATH`
- **`types.ts`** — 项目全局类型定义

## Three-Layer Distribution Model

```
Source layer（仓库内）
  plugins/marketplace-source.json
  plugins/<name>/.agents-plugin/plugin.json
  plugins/<name>/skills/**

          ↓ pnpm build / catalog staging

Catalog staging（生成产物）
  staging 或 build output
  ├── .claude-plugin/marketplace.json
  ├── .agents/plugins/marketplace.json
  └── plugins/<name>/
      ├── .agents-plugin/plugin.json
      ├── .claude-plugin/plugin.json  （支持 Claude 时存在）
      ├── .codex-plugin/plugin.json   （支持 Codex 时存在）
      ├── claude/**                   （支持 Claude 时存在）
      └── codex/**                    （支持 Codex 时存在）

          ↓ catalog pack / publish

npm Registry
  @yiliang/aw
  @yiliang/aw-plugins-manifest     # sidecar: catalog-manifest.json + history
  @yiliang/aw-plugins              # full: manifest + current snapshot artifacts

          ↓ aw init / install / upgrade 解析 selector、sidecar、full catalog

本地 AW runtime
  ~/.aw/
  ├── config.json
  ├── catalog-cache/<selector-or-version>/**
  ├── active-runtime/<platform>/**
  ├── dependency-index.json
  ├── native-markers/codex/user/<plugin>.<hash>.json
  ├── plugin-config/<plugin>/config.json
  ├── lifecycle-runtime/<...>/<plugin>/<digest>/**
  ├── shared-runtime-owners/<platform>/<plugin>.<hash>.json
  └── plugins/<name>/**            # active view 中给 native runtime 消费的 materialized 插件文件
```

三层各有职责，互不替代：

- 仓库源码层是插件作者维护的唯一输入，不手写平台 runtime manifest。
- catalog staging 是 `pnpm build` 和 catalog 发布脚本的输入产物，不手改。每个插件都必须保留 `.agents-plugin/plugin.json`；`.claude-plugin/`、`.codex-plugin/`、`claude/`、`codex/` 只在 `marketplace.policy.products` 解析出的支持平台上出现。
- `@yiliang/aw` CLI version、catalog package version 和插件 manifest version 是三套身份。插件或 catalog 更新不要求 CLI 发版；CLI 发布只负责命令和运行时能力。
- `@yiliang/aw-plugins-manifest` sidecar 包只包含 `catalog-manifest.json` 和必要 package metadata，负责兼容性、selector、history、sidecar/full identity 和 digest 真值；`@yiliang/aw-plugins` full 包包含同一份 manifest 和当前 catalog 单版本快照的全部插件 artifact。
- catalog history 记录历史 catalog version、catalog 最低 CLI 版本、插件 version、插件最低 CLI 版本、`artifactDigest` 和 `manifestDigest`。它服务历史兼容 catalog 查询和发布门禁，不是最新 catalog 内可直接安装的多版本索引。
- 根级 `.claude-plugin/marketplace.json` 和 `.agents/plugins/marketplace.json` 共享根级元数据，但插件 entries 按支持平台过滤，不要求两边插件列表完全一致。AW current catalog 以 catalog manifest 中的 entries 和每个插件 artifact 内的 `.agents-plugin/plugin.json` 为准。
- `~/.aw/` 是本机 catalog cache、active runtime view 和 AW 状态目录。`aw init` 只预热远程 catalog/cache；需要 native plugin runtime 的写命令会在调用平台前 materialize 并校验 active local marketplace/runtime view。纯 Codex project 路径只读使用 current catalog，不会为了项目产物初始化或修复用户级 native runtime。
- current catalog selector 只允许默认 channel、显式 dist-tag 和显式 exact catalog version。cache 快路径和 fallback 都必须匹配本次 selector、channel / exact version、schema、integrity 和最低 CLI 版本；latest 被当前 CLI 阻止时，只能按 sidecar history 查询同轨道历史兼容 catalog，不能用 npm metadata 或 cache 推翻 `catalogHistoryUnavailable` / `awVersionTooLow`。
- `native-markers/` 只保存短生命周期 native transaction marker。它表示外部 native 写入已经发生、但 AW record 尚未成功提交；后续 `status --verbose`、`repair` 或 `cleanup` 可以据此收口，marker 本身不代表安装成功。
- `dependency-index.json` 是跨 scope incoming edge 的索引，只辅助依赖保护、未使用依赖提醒和汇总视图；它不是安装真值。索引不可用或覆盖范围不可信时，删除类命令必须 fail closed。
- `lifecycle-runtime/` 或等价 snapshot 保存最小 historical runtime。普通卸载、只重放已安装版本的 repair、必要 reinstall 撤销阶段、config schema 读取和动态 artifact refresh 都使用它。它不解释 current catalog 或新的依赖声明。
- `shared-runtime-owners/` 记录同一 plugin/platform 的共享 runtime owner 身份和完整性证据。它决定谁可以写共享 runtime，但不保存 SkillTrigger 真值；`aw init` / marketplace refresh replay 必须从 owner location 当前 effective built-in config 重新计算触发策略。
- `plugin-config/` 是 user config store。project scope 另有 shared/local 两层配置，见 Runtime State。
- 动态 `codex.skill` 的静态模板随源码和 catalog artifact 分发；安装时由 renderer 输出当前配置下的 skill 内容，再由 AW apply 写入 user runtime 或 project repo-visible `.agents/skills/<skillKey>`。配置刷新和 refresh-only 重新执行 renderer 时使用 install record 指向的 historical runtime，避免 Codex user runtime 写回 active view 后污染下一次模板读取。renderer 不写 runtime 目录，也不写 diagnostic cache、install record 或 project artifact identity。

排查问题时先确认问题发生在哪一层：源码 contract、bundle 生成、本机 runtime 镜像，还是平台配置。

## Key Paths

- `Makefile` — 本地开发安装、测试版发布和正式版发布的统一入口
- `package.json` — repo root 统一脚本入口，包含 `build`、`test`、`release:*`、`publish:cli`
- `scripts/release/*.mjs` — 版本同步、tarball 打包、本地 `npm install -g` 和发布编排脚本
- `packages/cli/scripts/bundle-plugins.ts` — build 时把源码插件打成 catalog staging / runtime bundle
- `packages/cli/plugins-dist/`、catalog staging、`packages/cli/dist/`、`packages/cli/coverage/`、`.release/tarballs/` — 产物目录，不手改；CLI tarball 不把 `plugins-dist/` 作为正式插件兜底发布
- `plugins/git-commit/` — 真实样例插件，演示标准插件结构
- `.agents/skills/create-agent-workflows-plugin/` — 插件作者工具（含 `SKILL.md`、`agents/openai.yaml`、脚手架/校验脚本和 `references/` 下的作者参考文档）
- `docs/plugin-installation.md` — CLI 使用、scope/platform 行为和排障入口
- `docs/plugin-authoring.md` — 插件源码 manifest、hook、skill trigger 与 scope 语义入口

## Runtime State

- 执行型命令默认使用 `scope=user`，但绑定真实插件 target 的写入口必须显式传 `--platform codex|claude|both`；`status` 的 `scope/platform` 是过滤条件，未传 `--platform` 时按 `both` 查看所有真实状态证据。
- current catalog 解析统一接收 selector：默认 channel、`--catalog-channel <dist-tag>` 或 `--catalog-version <semver>`。`aw init`、安装、升级、重装、状态查看、发现入口，以及需要 current catalog schema 的未安装配置路径都使用同一解析结果。`aw init --channel <dist-tag>` 只是 `--catalog-channel` 的兼容别名。显式 selector 只影响当前命令或本次预热，不污染默认 channel cache。
- latest catalog 的最低 CLI 版本高于当前 CLI 时，解析器会记录 `latestCatalogBlocked`，并只根据 sidecar history 查询同轨道历史兼容 catalog；history 缺失或不可校验固定映射为 `catalogHistoryUnavailable`，history 确认没有兼容 catalog 固定映射为 `awVersionTooLow`。已经解析出允许使用的 catalog identity 后，匹配 cache 可作为普通快路径使用；强制刷新、远程不可用或 sidecar/full 校验失败时，匹配 cache 才按 `cacheFallback` 暴露原始阻断原因。
- `aw config` 写命令默认写 `user` store；读命令默认读取 effective config，合并顺序为 manifest default < user store < project shared store < project local store。user store 位于 `<AW_HOME>/plugin-config/<plugin>/config.json`，project shared store 位于 `<repo>/.agent-workflows/plugin-config/<plugin>/config.json`，project local store 位于 `<repo>/.agent-workflows/plugin-config.local/<plugin>/config.json`。脚本化配置写入入口是 `aw config set/unset/reset/get/list`；已移除的交互式 configure 入口不再作为可执行命令出现。
- 已安装位置的 config schema source 优先来自 install record 绑定的 historical runtime / manifest；未安装插件配置预置或未消费 store 才走 current catalog schema。多个 installed consumer 的 schema identity 冲突时，`list/get/set/unset` 返回 `configSchemaConflict`。`config reset` 区分已消费 store 和 orphan store：已消费 store 走 installed-aware write，receipt 暴露 `removedKeys` 和 `artifactRefresh`；orphan store 才 raw 删除，不伪造 schema identity，也不刷新 artifact。
- 动态 artifact 使用 artifact render config，而不是读命令的 effective config。user scope render config 只合并 manifest default 和 user store；project scope 的 repo-visible artifact render config 只合并 manifest default 和 project shared store 中可共享的键。user store、project local store 和 `file` / `directory` 路径型配置不得影响 project repo-visible artifact 内容、digest、stale 判断或 refresh。
- config 写入统一走共享 helper，输入表达 `updates` 和 `removeKeys`，receipt 返回 `updatedKeys`、`removedKeys`、`affectedFields` 和 `artifactRefresh`。命中 refresh key 时先保存 config store，再按 dynamic artifact evidence 执行刷新；SkillTrigger 内建字段保存后走 built-in apply pipeline，把 effective 触发策略写回已安装 runtime。refresh-only / 重新应用配置动作复用 artifact apply、diagnostic cache 写回和 built-in apply pipeline，但不修改 config store；脚本化收口配置驱动 runtime drift 的入口是 `aw repair <plugin> --platform <platform> --scope <scope>`。
- Claude Code：通过 `claude plugin marketplace add` / `claude plugin install` 接入本地 marketplace；项目或用户 scope 的 rules/permissions 由 CLI 生成，并由 install record、project artifact identity 和现场文件共同提供诊断证据。
- Codex user scope：需要原生 plugin 能力时先调用 `codex plugin marketplace add <canonical ~/.aw>` 注册 local marketplace，再通过 `codex app-server` 的 `plugin/install` / `plugin/uninstall` RPC 让 Codex 自己写入用户级 `[plugins."<plugin>@aw"]` 和 materialized cache。AW 不再提供只写 config 的 fallback；RPC 成功后必须用 post-check 同时确认 enabled config 与 active cache。
- Codex project scope：不调用 `codex plugin marketplace add`，不调用 app-server RPC，不写用户级 `[marketplaces]` / `[plugins]`，全部收敛为当前仓库 repo-visible artifacts：`.agents/skills/<skill>`（包含静态 skill、公共 slashCommands manual-only skill 和动态 `codex.skill`）、`.codex/config.toml [mcp_servers.*]` / managed instructions、`.codex/hooks.json`、`.codex/rules/*.rules`、`.codex/agents/*.toml`，以及 `.agent-workflows/project-artifacts/<platform>/<sharedIdentityId>.json`。动态 `codex.skill` 不要求 `.codex/config.toml` preflight；`codex.developerInstructionsBlock` 和 `codex.agentRole` 仍是 config-backed target。即使 PATH 缺少 `codex` 可执行文件，project target 也不能产生用户级 native side effect；命令事件中对应 skip reason 是 `project_repo_managed_skipped_native`。纯 native-only 插件和 `apps` 首版在 project scope fail fast。
- 每个平台/scope/plugin/location 都有独立 install record v2，位置分别落在 `~/.claude/.agent-workflows/records/`、`<project>/.claude/.agent-workflows/records/`、`~/.codex/.agent-workflows/records/` 或 `<repo>/.codex/.agent-workflows/records/`。record 是 AW 的安装真值，只保存 ownership、必要安装选项、安装来源和 canonical outgoing dependency edges；SkillTrigger 真值来自 manifest `defaultTrigger`、AW 内建配置 effective 值和当前 runtime evidence。健康状态从 current catalog、平台现场、project artifact identity、dynamic diagnostic cache、historical runtime、dependency index、shared owner 和 native marker 推导。
- project private state / local config 默认忽略：`.claude/.agent-workflows/`、`.codex/.agent-workflows/`、`.agent-workflows/plugin-config.local/`。project shared config 和 project artifact identity 是可提交输入，`.agent-workflows/plugin-config/`、`.agent-workflows/project-artifacts/` 不能被默认忽略。

## Plugin Scripts and Config

`.agents-plugin/plugin.json` 中的 `scripts` / `config` / `artifacts.targets` 是 AW CLI contract，不会写入 Claude/Codex platform manifest。`artifacts.targets` 是动态 artifact 的安装前能力真值，统一进入 installability、discovery、status current catalog、Codex project write safety preflight 和 install record artifact identity。`pnpm build` 使用 staging 模式处理显式 `scripts.node.build`，build 后重新读取 staging manifest 作为 marketplace entry、bundle source manifest、platform manifest base、runtime 文件收集和 `pnpm plugin:test` 的真值；`marketplace.policy.products` 也以这份 staging manifest 为准参与平台裁剪。源码树不被修改。

`dependencies.plugins` 也是 AW CLI contract，只保留在 source manifest 和 runtime bundle 的 `.agents-plugin/plugin.json`。`pnpm build` 会在 build script 改写 staging manifest 后重新校验依赖声明；`.claude-plugin/plugin.json`、`.codex-plugin/plugin.json` 和平台 marketplace manifest 不包含 `dependencies`，避免把 AW 自管依赖字段泄漏给平台原生 schema。

发布 bundle 只保留运行时需要的 lifecycle/helper/artifact renderer 入口、这些 Node 入口的静态相对依赖闭包、`scripts.node.packageRoot` 的 `package.json` / `pnpm-lock.yaml` / production `node_modules`。测试文件、test-only helper、build 入口和 dev-only 模块不进入发布 runtime bundle。运行时 lifecycle 和 artifact renderer 离线执行，不安装依赖，不回退到宿主或仓库根 `node_modules`。

install/upgrade 会先按 schema 做 required config preflight；脚本化子命令缺配置时 fail fast 并提示 `aw config set` 或 `aw` 主控制台。Codex project install / explicit upgrade / mixed explicit command 在 required config 检查之前还会先完成安全预检：project installability、用户级 Codex config external ownership、必要的 project `.codex/config.toml` 解析、project artifact identity 和未受管 repo artifact 冲突。安全预检失败路径完全只读，不能创建 config store，不能写 native state、artifact、identity 或 install record。lifecycle 执行时机是：install/upgrade 在平台状态和 repo-visible artifacts 写完后、install record 提交前执行；uninstall 在平台卸载和 artifact 清理前执行。失败会阻断命令并保留可重试状态。

写命令在第一笔外部状态写入前都会先调用 dependency planner 展开完整图。planner 按父插件本次已确定的 platform 过滤 `when.platforms`，用 `(plugin, platform, scope, projectKey)` 选址、复用仍健康的旧 edge，并做循环、缺失 catalog、平台兼容、scope installability、required config、external ownership、project artifact identity、role namespace 和 project safety 等图级 preflight。`install` 按依赖优先的拓扑顺序写入，缺失依赖会自动安装，已满足依赖不会重复安装但会刷新父插件 outgoing edge。`upgrade <plugin>` 先安装缺失依赖，再升级已安装依赖，最后升级显式目标；`upgrade --all` 只把 explicit 保留的安装作为根，不把孤立 auto dependency 当成用户目标。`uninstall` 会保护仍被其它插件依赖的位置；父插件卸载后，如果某个自动依赖没有可信 incoming edge，只提示用户显式处理，不自动卸载。

依赖满足规则是 location-aware 的。user 父插件只能由同 platform 的 user scope 健康依赖满足，user 父插件声明当前 platform 生效的 `target.scope: "project"` 会在写入前失败。project 父插件省略 `target.scope` 时优先使用当前 project，当前 project 不健康或缺失时可 fallback 到 user scope；显式 `target.scope: "user"` 只看 user，显式 `target.scope: "project"` 只看当前 project，不做 user fallback。external-only、marker-only、enabled-only、cache-only、identity 损坏或需要 repair 的位置都不算健康依赖。

动态 artifact 的写路径分三段：先执行 renderer，拿到 stdout JSON `ArtifactPlan`；再由 `artifact-plan.ts` 按当前 platform/scope 的 `artifacts.targets` 校验 `id`、`target`、`state`、`refreshKeys`、`skillKey`、`roleKey` 和 target content；最后交给 adapter 的 target apply 写入受管文件。install/upgrade 的 renderer 源是本次解析出的 bundle，config-triggered refresh 和 refresh-only 的 renderer 源是 install record 中校验过的 historical bundle。renderer 和 lifecycle 都不能直接写 AW 受管文件，`.agents/skills/**`、Codex user runtime skill、`.codex/config.toml`、`.codex/agents/*.toml`、dynamic diagnostic cache、project artifact identity 和 install record 等写盘集中在 AW target apply 和命令提交阶段。

当前 target runtime 支持 `codex.skill`、`codex.developerInstructionsBlock` 和 `codex.agentRole`。`codex.skill` 用 manifest 静态 `skillKey` 做安装前路径冲突检查，renderer content 只提供 `skillFile` 和 `openaiYaml`，apply 阶段按当前 effective SkillTrigger 配置 patch 后写入 project `.agents/skills/<skillKey>` 或 Codex user runtime，并以 `projectManagedKind = "skill"` 写 project artifact shared identity。`codex.developerInstructionsBlock` 把 present content 合成到当前 scope 的 Codex AW managed developer instructions block，disabled 时移除或跳过该 artifact 的受管 instruction。`codex.agentRole` 用 manifest 静态 `roleKey` 做安装前 role namespace preflight，apply 阶段写 role layer，再 upsert 当前 scope Codex config 的 `[agents.<roleKey>]` 注册项；renderer 不能提供 `registration.config_file` 或任意落盘路径。落在同一 Codex config 的 instruction 和 role registration 共享文档级事务和 rollback baseline。

config-triggered refresh 发生在 config store 写入成功之后，只刷新 dynamic diagnostic cache / install evidence 中 `refreshKeys` 命中的动态 artifact。user scope 写入最多刷新 user target 和当前 repo project target，project scope 写入只刷新当前 repo project target，不扫描历史 project。刷新失败不回滚 config store，而是在 dynamic diagnostic cache 的 `lastRefresh` 记录失败摘要，并用 `refreshReach` 写实说明本次覆盖范围和其它已知 project target 是否可能 stale。若 install record 或 historical bundle 不可用，刷新会 fail closed，提示通过 repair 重建安装状态。

stale prune 以当前 manifest 的 `artifacts.targets`、install record artifact identity 和 project artifact shared identity 为准。当前版本不再声明某个 AW-owned dynamic `codex.skill`、instruction 或 role artifact 时，upgrade/cleanup/remove 只能清理有 ownership evidence 的残留；同名但非 AW-owned 的 repo skill、runtime skill 或 role 文件必须保留。

每个成功安装的 platform + scope + plugin 都会保存最小 historical runtime / snapshot。普通 `uninstall`、只重放已安装版本的 `repair`、必要 `reinstall` 撤销阶段、config schema 读取、config-triggered refresh 和 refresh-only 都会使用它。它不作为 current catalog 或新 dependency manifest 的来源。缺失或损坏会影响卸载安全性、repairability、配置 schema 读取和动态刷新，status 会降级为需要处理。

install record 对依赖只持久化两类事实：`installSource` 表示 explicit / dependency 来源和是否被用户显式保留；`dependencyEdges` 表示当前安装对依赖的 canonical outgoing edges。edge 端点包含完整 `PluginLocation`，声明摘要包含 `name`、`target.scope`、`inheritInstallOptions` 和 `when.platforms`。读路径从 per-plugin records 重建 dependency index，再构建 incoming dependents view，供卸载保护、未使用依赖提醒、status 和主控制台复用；`dependents`、ref-count 和 `autoRemovable` 不落盘，只从 edge 图和安装来源实时推导。dependency index 缺失、不可信、stale project reference 未显式退休，或 record edge 不完整时，依赖相关删除命令 fail closed。

## Command Runtime

CLI entry 和 direct command 共用 `CommandExecutionContext`。所有会影响外部世界的能力都从这里进入：`env`、adapter factory、native CLI runner、prompt、reporter、debug logger 和 diagnostics。新增 helper 时必须继续消费 context 里的 `env`，不能退回 `process.env`；测试也应该通过同一条 context 注入 fake runner、fake prompt 或 fake adapters。

`aw` 主命令是唯一交互入口。TTY 下由 `commands/console.ts` 通过 prompt adapter 驱动控制台；非 TTY、CI 或交互不可用时不会挂起，会输出清晰说明、可复制脚本命令和 `--json` 提示。prompt adapter 提供 `select`、`confirm`、`input`、`password`、滚动列表、返回和取消结果，默认实现基于 inquirer，并保留可注入 fake prompt / console driver 供测试使用。

底层 `installCommand`、`uninstallCommand`、`upgradeCommand`、`config` 写命令按确定性 options 执行，便于脚本化调用和单元测试；即使 runtime 注入 fake prompt，子命令也不能 prompt。控制台动作使用带身份的 location，身份包含 plugin、platform、scope、projectKey 和 executionCwd，不能只按插件名模糊 dispatch。配置向导必须返回 selected scope、dirty updates、removeKeys、updatedKeys 和 removedKeys；命令层只 patch 本次显式更新或删除的 key，不能把整份 effective config 复制到目标层。

## Output and Debug

命令结果已经分为 JSON receipt 和默认人类 renderer。所有写命令的最小公共 receipt 包含 `receiptSchemaVersion: 2`、`ok`、`command`、`warnings`、`nextStepsSchemaVersion: 1` 和结构化 `nextSteps`；`install` / `uninstall` / `upgrade` 追加 `plugins`、`targets`、`actions`、`artifacts`、`native`、`skipped` 等命令字段，`config set/unset/reset` 追加 `updatedKeys`、`removedKeys`、`affectedFields` 和 `artifactRefresh`。`aw status --json` 顶层使用 `statusSchemaVersion: 2` 和 `consoleItemsSchemaVersion: 3`；`aw config list/get --json` 顶层使用 `configSchemaVersion: 2` 和 `fields`。`--json` stdout 必须是单一可解析 JSON；失败时 stdout 为空或仍是单一 JSON，错误和 warning 只写 stderr。

依赖写命令的 receipt 会区分用户显式目标和自动依赖目标：target 带 `requested`，自动依赖带 `dependencyOf`；actions 能表达 `installDependency`、`upgradeDependency` 和手动清理建议。默认人类输出只用短句说明自动安装、依赖升级或保守跳过结果，不暴露 dependency edge、ref-count、record 字段名等内部结构。

默认 stdout 面向日常使用，只说明目标插件、位置、结果和必要下一步，不展示内部状态存储或低层运行时细节。可复制命令、argv、flag、JSON 字段和类型名保留真实技术标识。纯 Codex project 成功路径不输出 native marketplace add 或 plugin enabled 成功信息；`--verbose` 把 options normalization、platform/catalog 选择、marketplace 修复判断和降噪后的 drift 诊断写到 stderr；`--debug` 或 `AW_DEBUG=1` 生成脱敏 debug log，并隐含 verbose。

debug log 记录 runId、argv、cwd、关键路径、native invocation、文件写入摘要、rollback/degraded 和最终错误，但不记录完整敏感内容。写命令默认写到 `~/.aw/logs`；`status` 默认写到系统临时目录，避免为了诊断破坏只读合同。`status --json` 独占 stdout，人类诊断、warning 和 debug log 路径只能进入 stderr 或日志文件。

Codex native 写命令会发结构化 command event，debug log 和 `--verbose` 依赖同一合同：

- `native:marketplace`：Codex user scope 注册或校验本地 marketplace，核心字段为 `platform`、`scope`、`plugin`、`marketplaceName`、`marketplacePath`、`operation`、`phase`、失败时的 `errorCategory` / `suggestion`。
- `native:rpc`：调用 `plugin/install` 或 `plugin/uninstall`，核心字段为 `pluginId`、`method`、`phase`、`durationMs`、`nativeWriteSucceeded`，失败时带 app-server 错误分类和建议。
- `native:transaction`：写入、更新或删除 native transaction marker，核心字段为 `operation`、`state`、`nativeWriteSucceeded`、`markerPersisted`。
- `native:post-check`：RPC 后校验 enabled config 与 active cache，核心字段为 `operation`、`pluginEnabled`、`configEntryPresent`、`pluginInstalled`、`activeCachePath`。
- `native:skipped`：目标不需要 native 写入，Codex project 路径必须带 `reason=project_repo_managed_skipped_native`、`requiresNativeRuntime` 和 `repoManagedArtifactKinds`。

## Discovery and Status

`commands/discovery.ts` 是 status 和主控制台候选来源，也为脚本化 uninstall/upgrade/repair/cleanup 恢复目标身份。它通过 install-state facade 合并 current catalog、平台现场、project artifact identity、per-plugin install record、dynamic diagnostic cache、historical runtime、dependency index、shared runtime owner 和 native transaction marker；current catalog 找不到时只生成保守的 historical placeholder。默认 `status` 候选不会把纯 catalog-only 插件放入 `consoleItems`，主控制台通过 `loadConsoleItems({ includeCatalogOnly: true })` 额外读取 current catalog，用来在首页展示尚未安装但可管理的插件。

historical placeholder 必须按 platform + scope 分格。Codex 只有粗略归属线索时，不能恢复成 hook、instruction、permission 或 agent 等具体能力；只有 install record、project artifact identity 或现场 marker 中存在明确 artifact kind / hook identity 等证据时，才能恢复对应能力。

artifact identity 必须带足够的稳定身份信息。`kind: "skill"` 和 `kind: "mcpServer"` 需要 `artifactKey`：skill 使用 skill 目录名，MCP 使用 rendered `.mcp.json` 的原始 server key。`.codex/config.toml` 是共享文件，多个 MCP server 不能只靠 path 区分；包含点号、空格、斜杠或 Unicode 的 key 必须按 TOML quoted key 语义处理，例如 `[mcp_servers."acme.tools v1"]` 表示单个 server key，而不是嵌套路径。

dynamic diagnostic cache 额外记录动态 artifact 的 `id`、`target`、`state`、`disabledReason`、`configDigest`、`contentDigest`、`lastRefresh` 和 `refreshReach`。status、discovery、主控制台动作和 direct uninstall/upgrade 都应优先使用 artifact id/target/skillKey/roleKey 恢复身份；current catalog 缺失时只能从 install record、project artifact identity 和 runtime evidence 保守恢复，不能编造假 skill 或 role 名。uninstall 清理 AW 受管 skill 目录、instruction block、role registration 和 role layer；遇到用户手写或外部接管内容时不得删除用户文件。

`aw status` 是只读状态面板。它默认跨 platform/scope 扫描，输出“状态摘要 + 友好位置 + 下一步”；`--verbose` 展开诊断字段；`--json` 输出稳定 schema。`status --json` 顶层包含 `statusSchemaVersion: 2`、`consoleItemsSchemaVersion: 3`、`ok`、`command`、`friendlySummaries` 和 `consoleItems`。`statusSchemaVersion: 2` 管理 status envelope 和 verbose JSON 详细状态；V3 `consoleItems` 是公开 summary 合同，只包含插件显示信息、四类友好状态、location summary、reason code、结构化 next steps、SkillTrigger 公共投影和 `features`。

控制台模型分四层，不能互相泄漏职责：

- `PluginConsoleSummary`：公开 JSON summary，面向 `status --json.consoleItems`，只表达插件显示信息、友好状态、位置摘要、reason code、下一步和功能入口。
- `PluginConsoleSummary.features`：功能菜单 summary，只表达“可以进入哪些功能”和目标选择策略，不携带最终 target、确认文案、命令字符串或页面展示字段。
- `PluginConsoleExecutableAction`：执行层 action，只能在控制台完成功能选择和目标选择后生成，必须带完整 target；它不暴露 `command[]`，`force: true` 只能由 `runCleanup` 生成。
- Console page model：TUI 页面层从 summary 和执行层上下文派生 `statusIcon`、`statusTone`、`platformBadges`、`primaryActionLabel`、`targetOptions` 等字段；这些字段不进入 `status --json.consoleItems`。

诊断页需要展示补充命令时，只能把 `command?: string[]` 留在诊断 payload / supplemental commands 一侧。`status --json.consoleItems` 不输出旧 `locations[].actions[]`、确认文案、命令数组或页面层字段。

status 的依赖信息完全走只读 planner 投影和 dependency index，不触发安装、修复、renderer、lifecycle 或自动清理。JSON 中 `dependencies` 展示 `declared`、`resolved`、`satisfied`、`missing`、`dependents`、`autoInstalled`、`autoRemovable`、`catalogDrift` 和 `dependencyIndexTrusted`：当前健康层缺失依赖会进入 `needsAttention`；current catalog 新增或移除依赖只作为 drift 展示，不会把旧安装直接判成缺失依赖；当前 platform 不生效的 entry 只进入 `declared`，不参与 ready / needsAttention。

投影层的 action 合同是安全边界：公开 summary 不包含任何立即写状态的动作，也不承载多 location 隐式批量写。`runInstall`、`runUpgrade`、`runUninstall`、`runRepair`、`runCleanup`、`runReinstall`、`runAdoptExisting`、`runTakeoverSharedRuntime`、`resolveDuplicateInstall`、`runReapplyConfigRefresh` 等执行动作只能在控制台完成功能和目标选择之后生成，并且必须带完整 target，project 动作需要时带 `projectKey`。删除、覆盖和 cleanup 动作必须用 `destructive`、确认页和目标合同表达风险；`force: true` 只能由 `runCleanup` 生成。disabled 功能必须带 `disabledReason`，控制台不能靠 `label` 判断行为。

Codex project scope 的默认视图以 repo-visible artifacts、project artifact identity 和本机 install record 为主，用户级 native marketplace 注册缺失只在相关诊断中出现，不能替代正常 installed signal。status、discovery 和相关 adapter status 路径不能调用 `ensureLocalMarketplace()` 或修复 `~/.aw`；current catalog unavailable 时只能展示已有本地证据和 catalog unavailable 状态，不能回退 embedded catalog 或伪造升级判断。

Codex user native status 中，`native.pluginInstalled` 表示 Codex materialized cache 中存在单一 active version，不再表示 config enabled；`native.pluginEnabled` 表示 `~/.codex/config.toml [plugins."<plugin>@aw"].enabled === true`；native transaction marker 只表示需要收口的短生命周期写入。enabled-only、cache-only、shared-ref-only、marker-only 都会进入 `needsAttention` 或诊断候选，不会被静默折叠成 `notInstalled`。

`upgrade --all` 的 skipped target 是 direct command 返回值的一部分，CLI receipt 同步展示 succeeded / skipped。部分成功部分 skipped 时退出 `0`；全部 target skipped 且没有成功升级时退出 `1`。稳定 code 集合包含 `scopeNotInitialized`、`codexProjectUserConfigUnreadable`、`externalOwnershipUnknown`、`externalOwnershipPresent`、`projectArtifactIdentityError`、`installOptionsUnavailable`、`catalogNotCurrent`、`catalogNotProjectInstallable`、`projectConfigUnreadable`、`unmanagedRepoArtifactConflict`、`dependencyIndexUntrusted` 和 `sharedRuntimeOwnerConflict`。

config/script/artifact health 是 status matrix cell 的只读派生信息。status 可以读取 config store、current catalog、dynamic diagnostic cache、project artifact identity 和 install record 来展示 `configured`、`missing-required`、`invalid-config`、`no-schema`、动态 artifact health、config digest stale、recent refresh failed 与 `refreshReach` 诊断，但不能创建 config 目录、执行 lifecycle、执行 artifact renderer、刷新 marketplace 或用 config store 反推插件已安装。
