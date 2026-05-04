# Architecture

## CLI Source Layout (`packages/cli/src`)

- **`commands/`** — 编排 `init`、`install`、`uninstall`、`upgrade`、`config`、`status`；`options.ts` 统一归一化命令参数，`runtime.ts` 统一注入 env、native runner、prompt、reporter 和 debug logger，`discovery.ts` 枚举受管或可发现插件，`interactive.ts` 只在 CLI entry 层处理候选选择，`common.ts` 放平台推断、catalog/ledger 准备和共享状态格式化逻辑
- **`adapters/`** — `claude.ts` / `codex.ts` 处理平台原生状态与命令调用；`helpers.ts` 放共享 adapter 逻辑；`types.ts` 放 adapter 层私有类型
- **`generators/`** — `instructions.ts` / `permissions.ts` / `hooks.ts` / `agents.ts` 分别生成对应产物；`local-plugin.ts` 处理 bundle 和 repo-managed 文件生成；`shared.ts` 放跨生成器共享逻辑
- **`output/`** — `reporter.ts` 负责 stdout/stderr 的 notices、warnings 和 verbose 诊断渲染；`debug-log.ts` 负责调试日志落盘、轮转和失败提示；`redact.ts` 统一脱敏 token、password、authorization、cookie 等敏感字段
- **`utils/`** — `manifest.ts` 解析 plugin manifest；`slash-commands.ts` 解析公共 `slashCommands` 并生成 Claude commands / Codex manual-only skills；`marketplace.ts` / `local-marketplace.ts` 处理 marketplace 数据和安装账本；`plugin-catalog.ts` 做 catalog 解析和 embedded/local 选择；`plugin-config.ts` 管理 AW 自管配置 store、schema 校验和 install/upgrade preflight；`plugin-scripts.ts` 管理安装快照、lifecycle target、context 和 runner；`artifact-renderer.ts` 执行动态 artifact renderer 并解析 artifact render config；`artifact-plan.ts` 校验 `ArtifactPlan` 并计算 digest；`artifact-refresh.ts` 处理 config-triggered refresh；`plugin-script-contract.ts` 扫描 Node import contract；`tracking.ts` 管理项目侧生成产物清单；`generated-artifacts.ts` 管理生成产物与回滚；`bundle-layout.ts` 校验 embedded bundle 一致性；`codex-config.ts` 做 Codex 配置 round-trip；`skill-trigger-preferences.ts` 处理安装时触发策略物化和 drift 检查；`paths.ts` / `detect.ts` / `file-rules.ts` 等放底层辅助
- **`constants.ts`** — 全局常量：`GENERATED_FILE_PREFIX = 'aw-'`、`TRACKING_MANIFEST_FILE = '.agent-workflows-manifest.json'`、`DEFAULT_CLAUDE_HOOKS_PATH`、`CLAUDE_MARKETPLACE_PATH`、`CODEX_MARKETPLACE_PATH`
- **`types.ts`** — 项目全局类型定义

## Three-Layer Distribution Model

```
Source layer（仓库内）
  plugins/marketplace-source.json
  plugins/<name>/.agents-plugin/plugin.json
  plugins/<name>/skills/**

          ↓ pnpm build（scripts/bundle-plugins.ts 打包）

Embedded Runtime Bundle（npm 包内）
  packages/cli/plugins-dist/
  ├── .claude-plugin/marketplace.json
  ├── .agents/plugins/marketplace.json
  └── plugins/<name>/{.agents-plugin,.claude-plugin,.codex-plugin,...}

          ↓ make pack / make local-install（生成并验证 `.release/tarballs/*.tgz`）
          ↓ make beta-release VERSION=x.y.z-beta.n / make release VERSION=x.y.z

npm Registry
  @yiliang/aw

          ↓ aw init / 安装流程同步

本地 Marketplace 镜像
  ~/.aw/
  ├── config.json
  ├── installed.json
  ├── plugin-config/<plugin>/config.json
  ├── plugin-install-snapshots/<...>/<plugin>/<digest>/bundle/**
  └── plugins/<name>/**
```

三层各有职责，互不替代：

- 仓库源码层是插件作者维护的唯一输入，不手写平台 runtime manifest。
- `packages/cli/plugins-dist/` 是 `pnpm build` 产物，会随 npm 包发布，不手改。
- `~/.aw/` 是本机 marketplace 镜像和安装账本。需要 native plugin runtime 时，`aw init`、`aw install`、`aw upgrade` 会按需同步；纯 Codex project repo-managed 路径只读使用 catalog，不会为了项目产物初始化或修复共享 runtime。
- `plugin-config/` 和 `plugin-install-snapshots/` 是 AW 自管运行时状态。local marketplace refresh 会保留它们；它们不参与 bundle fingerprint，也不会被当作插件源码。

排查问题时先确认问题发生在哪一层：源码 contract、bundle 生成、本机 runtime 镜像，还是平台配置。

## Key Paths

- `Makefile` — 本地开发安装、测试版发布和正式版发布的统一入口
- `package.json` — repo root 统一脚本入口，包含 `build`、`test`、`release:*`、`publish:cli`
- `scripts/release/*.mjs` — 版本同步、tarball 打包、本地 `npm install -g` 和发布编排脚本
- `packages/cli/scripts/bundle-plugins.ts` — build 时把源码插件打成 `plugins-dist`
- `packages/cli/plugins-dist/`、`packages/cli/dist/`、`packages/cli/coverage/`、`.release/tarballs/` — 产物目录，不手改
- `plugins/git-commit/` — 真实样例插件，演示标准插件结构
- `.agents/skills/create-agent-workflows-plugin/` — 插件作者工具（含 `SKILL.md`、`agents/openai.yaml`、脚手架/校验脚本和 `references/` 下的作者参考文档）
- `docs/plugin-installation.md` — CLI 使用、scope/platform 行为和排障入口
- `docs/plugin-authoring.md` — 插件源码 manifest、hook、skill trigger 与 scope 语义入口

## Runtime State

- 执行型命令（`install`、`uninstall`、`upgrade`）默认使用 `scope=user`、`platform=auto`；`status` 的 `scope/platform` 是过滤条件，不在 CLI entry 层套用写入型默认值。
- `aw config` 写命令默认写 `user` store；读命令默认读取 effective config，合并顺序为 manifest default < user store < project store。user store 位于 `<AW_HOME>/plugin-config/<plugin>/config.json`，project store 位于 `<AW project root>/.agent-workflows/plugin-config/<plugin>/config.json`。AW project root 在仓库或 workspace 内解析到 repo root，非仓库目录退回 normalized command `cwd`。
- 动态 artifact 使用 artifact render config，而不是读命令的 effective config。user scope render config 只合并 manifest default 和 user store；project scope render config 合并 manifest default、user store 和当前 project store。status 可按同一 scope 规则只读计算 config digest / stale 诊断，但不能执行 renderer。
- Claude Code：通过 `claude plugin marketplace add` / `claude plugin install` 接入本地 marketplace；项目或用户 scope 的 rules/permissions 由 CLI 生成并用 `.agent-workflows-manifest.json` 追踪。
- Codex user scope：需要原生 plugin 能力时先调用 `codex plugin marketplace add <canonical ~/.aw>` 注册 local marketplace，再由 AW 写入用户级 `[plugins."<plugin>@aw"] enabled = true`。Codex local source 注册不会产生 `.tmp/marketplaces/aw` 物化副本，status 也不应要求这个副本存在。
- Codex project scope：不调用 `codex plugin marketplace add`，不写用户级 `[marketplaces]` / `[plugins]`，全部收敛为当前仓库 repo-managed artifacts：`.agents/skills/<skill>`、`.codex/config.toml [mcp_servers.*]` / managed instructions、`.codex/hooks.json`、`.codex/rules/*.rules`、`.codex/agents/*.toml` 和 `.codex/.agent-workflows-manifest.json`。`apps` 首版在 project scope fail fast。
- 两个平台共享 `~/.aw/installed.json`。它记录 scope、平台、能力快照、`skillTriggerPreference` 和 lifecycle/config 安装快照元数据，用于重复安装、升级、卸载、historical lifecycle 选择和 status drift 判断。

## Plugin Scripts and Config

`.agents-plugin/plugin.json` 中的 `scripts` / `config` / `artifacts.targets` 是 AW CLI contract，不会写入 Claude/Codex platform manifest。`artifacts.targets` 是动态 artifact 的安装前能力真值，统一进入 installability、discovery、status current catalog、Codex project write safety preflight 和 ledger capability snapshot。`pnpm build` 使用 staging 模式处理显式 `scripts.node.build`，build 后重新读取 staging manifest 作为 marketplace entry、bundle source manifest、platform manifest base、runtime 文件收集和 `pnpm plugin:test` 的真值。源码树不被修改。

发布 bundle 只保留运行时需要的 lifecycle/helper/artifact renderer 入口、这些 Node 入口的静态相对依赖闭包、`scripts.node.packageRoot` 的 `package.json` / `pnpm-lock.yaml` / production `node_modules`。测试文件、test-only helper、build 入口和 dev-only 模块不进入发布 runtime bundle。运行时 lifecycle 和 artifact renderer 离线执行，不安装依赖，不回退到宿主或仓库根 `node_modules`。

install/upgrade 会先按 schema 做 required config preflight；交互可用时调用同一套 prompt 补问配置，非交互时 fail fast。Codex project install / explicit upgrade / mixed explicit command 在 required config prompt 之前还会先完成安全预检：project installability、用户级 Codex config external ownership、必要的 project `.codex/config.toml` 解析、tracking identity 和未受管 repo artifact 冲突。lifecycle 执行时机是：install/upgrade 在平台状态和 repo-managed artifacts 写完后、tracking/ledger 提交前执行；uninstall 在平台卸载和 artifact 清理前执行。失败会阻断命令并保留可重试状态。

动态 artifact 的写路径分三段：先执行 renderer，拿到 stdout JSON `ArtifactPlan`；再由 `artifact-plan.ts` 按当前 platform/scope 的 `artifacts.targets` 校验 `id`、`target`、`state`、`refreshKeys`、roleKey 和 target content；最后交给 adapter 的 target apply 写入受管文件。renderer 和 lifecycle 都不能直接写 AW 受管文件，`.codex/config.toml`、`.codex/agents/*.toml`、tracking、ledger 等写盘集中在 AW target apply 和命令提交阶段。

首版 target runtime 只支持 `codex.developerInstructionsBlock` 和 `codex.agentRole`。前者把 present content 合成到当前 scope 的 Codex AW managed developer instructions block，disabled 时移除或跳过该 artifact 的受管 instruction。后者用 manifest 静态 `roleKey` 做安装前 role namespace preflight，apply 阶段写 role layer，再 upsert 当前 scope Codex config 的 `[agents.<roleKey>]` 注册项；renderer 不能提供 `registration.config_file` 或任意落盘路径。落在同一 Codex config 的 instruction 和 role registration 共享文档级事务和 rollback baseline。

config-triggered refresh 发生在 config store 写入成功之后，只刷新 tracking 中 `refreshKeys` 命中的动态 artifact。user scope 写入最多刷新 user target 和当前 repo project target，project scope 写入只刷新当前 repo project target，不扫描历史 project。刷新失败不回滚 config store，而是在 tracking 的 `lastRefresh` 记录失败摘要，并用 `refreshReach` 写实说明本次覆盖范围和其它已知 project target 是否可能 stale。

每个成功安装的 platform + scope + plugin 都有 scope-owned 安装快照。uninstall 和 status 优先用 ledger 中的 `lifecycleConfigSnapshot` 解释旧版本的 lifecycle/config 真值；只有快照缺失或损坏时才降级到 current catalog / historical fallback，并在诊断里标出。`healthSource` 只使用 `installSnapshot`、`currentCatalog`、`historical`、`none`，Codex `activeLocalBundle` 只作为 runtime evidence / drift 线索。

## Command Runtime

CLI entry 和 direct command 共用 `CommandExecutionContext`。所有会影响外部世界的能力都从这里进入：`env`、adapter factory、native CLI runner、prompt、reporter、debug logger 和 diagnostics。新增 helper 时必须继续消费 context 里的 `env`，不能退回 `process.env`；测试也应该通过同一条 context 注入 fake runner、fake prompt 或 fake adapters。

交互式逻辑只存在于 `commands/interactive.ts`、config prompt 和 CLI action 之间。底层 `installCommand`、`uninstallCommand`、`upgradeCommand` 仍按确定性 options 执行，便于脚本化调用和单元测试。交互式选择使用带身份的候选项，身份包含 plugin、platform、scope、projectKey 和 executionCwd，不能只按插件名模糊 dispatch。config prompt 必须返回 selected scope、dirty updates 和 updatedKeys；命令层只 patch 本次显式更新的 key，不能把整份 effective config 复制到目标层。

## Output and Debug

命令结果逐步从散落的 `output` / `warnings` 迁到结构化 notices 和 events。默认 stdout 面向日常使用，说明目标插件、platform、scope、实际使用的插件目录、native 注册或 repo-managed artifacts，以及下一步命令。纯 Codex project repo-managed 成功路径不输出 native marketplace add 或 plugin enabled 成功信息；`--verbose` 把 options normalization、platform/catalog 选择、marketplace 修复判断和降噪后的 drift 诊断写到 stderr；`--debug` 或 `AW_DEBUG=1` 生成脱敏 debug log，并隐含 verbose。

debug log 记录 runId、argv、cwd、关键路径、native invocation、文件写入摘要、rollback/degraded 和最终错误，但不记录完整敏感内容。写命令默认写到 `~/.aw/logs`；`status` 默认写到系统临时目录，避免为了诊断破坏只读合同。`status --json` 独占 stdout，人类诊断、warning 和 debug log 路径只能进入 stderr 或日志文件。

## Discovery and Status

`commands/discovery.ts` 是 status、交互式 uninstall 和交互式 upgrade 的候选来源。它合并 AW ledger、project tracking manifest、Codex/Claude 原生配置、runtime evidence 和 current catalog；current catalog 找不到时会生成保守的 historical placeholder。

historical placeholder 必须按 platform + scope 分格。Codex 只有 ledger coarse boolean（例如 `hasRepoManagedArtifacts: true`）时，不能恢复成 hook、instruction、permission 或 agent 等具体能力；只有 tracking artifact kind、hook identity 等明确证据存在时，才能恢复对应能力。

tracking manifest 中的 `GeneratedArtifact.path` 始终是绝对路径。`kind: "skill"` 和 `kind: "mcpServer"` 还必须带 `artifactKey`：skill 使用 skill 目录名，MCP 使用 rendered `.mcp.json` 的原始 server key。`.codex/config.toml` 是共享文件，多个 MCP server 不能只靠 path 区分；包含点号、空格、斜杠或 Unicode 的 key 必须按 TOML quoted key 语义处理，例如 `[mcp_servers."acme.tools v1"]` 表示单个 server key，而不是嵌套路径。

动态 artifact tracking 在 `GeneratedArtifact` 上额外记录 `id`、`target`、`state`、`disabledReason`、`refreshKeys`、`configDigest`、`contentDigest`、`roleKey`、`lastRefresh` 和 `refreshReach`。status、discovery、交互式 uninstall/upgrade、direct uninstall/upgrade 都应优先使用 artifact id/target/roleKey 恢复身份；current catalog 缺失时只能从 installed snapshot、tracking 和 runtime evidence 保守恢复，不能编造假 role 名。uninstall 清理 AW 受管 instruction block、role registration 和 role layer；遇到用户手写或外部接管内容时不得删除用户文件。

`aw status` 是只读状态面板。它默认跨 platform/scope 扫描，输出“状态摘要 + 明细 + 下一步”；`--verbose` 展开诊断字段；`--json` 输出稳定 schema。Codex project scope 的默认视图以 repo-managed evidence 为主，用户级 native marketplace 注册缺失只在相关诊断中出现，不能替代正常 installed signal。status、discovery 和相关 adapter status 路径不能调用 `ensureLocalMarketplace()` 或修复 `~/.aw`，stale 或损坏的本地 marketplace 只能只读回退 embedded catalog，并在 verbose/json 里说明原因。

`upgrade --all` 的 skipped target 是 direct command 返回值的一部分，CLI receipt 同步展示 succeeded / skipped。部分成功部分 skipped 时退出 `0`；全部 target skipped 且没有成功升级时退出 `1`。稳定 code 集合是 `scopeNotInitialized`、`codexProjectUserConfigUnreadable`、`externalOwnershipUnknown`、`externalOwnershipPresent`、`trackingIntegrityError`、`installOptionsUnavailable`、`catalogNotCurrent`、`catalogNotProjectInstallable`、`projectConfigUnreadable`、`unmanagedRepoArtifactConflict`。

config/script/artifact health 是 status matrix cell 的只读派生信息。status 可以读取 config store、安装快照、current catalog 和 tracking 来展示 `configured`、`missing-required`、`invalid-config`、`no-schema`、动态 artifact health、config digest stale、recent refresh failed 与 `refreshReach` 诊断，但不能创建 config 目录、执行 lifecycle、执行 artifact renderer、刷新 marketplace 或用 config store 反推插件已安装。
