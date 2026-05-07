# Testing Guidelines

测试框架 Vitest，测试文件统一 `*.test.ts`，位于 `packages/cli/tests/` 下的 `unit/`、`integration/`、`smoke/`、`helpers/`、`fixtures/`。

## Test Layers

- **`unit/` 和 `integration/`** — 保持 build-free，不依赖预先存在的 `plugins-dist`；需要 runtime bundle 输入时，用 `tests/helpers/embedded-root.ts` 生成临时 synthetic embedded root
- **`smoke/`** — 专门验证真实 `pnpm build` 和 `pnpm pack:cli` 产物，不进入常规 `pnpm test`
- **`pnpm plugin:test <plugin>`** — 插件作者脚本测试入口，先 compile CLI，再运行已编译的 `packages/cli/scripts/test-plugin-scripts.js`；它使用 staging 临时 bundle，但不是 `aw` 客户端子命令
- **`fixtures/repo-template/`** — 含 `.codex/`、`.claude/` 等完整项目结构示例
- **`fixtures/codex-config/`** — Codex 配置示例
- **`fixtures/codex-project-repo-managed/`** — Codex project scope repo-managed fixture 矩阵，覆盖 skills-only、mcp-only、slashCommands-only、skills+MCP、apps 拒绝和 quoted-key MCP

## Focus Areas

- CLI 命令入口：`tests/integration/cli-entry.test.ts` 覆盖 commander 参数、stdout/stderr 和退出码
- 命令编排与平台行为：`tests/integration/cli.test.ts`、`upgrade-command.test.ts`、`skill-trigger-command.test.ts`
- 作者工具：`tests/integration/authoring-tools.test.ts` 覆盖脚手架、校验脚本和作者文档关键约定
- 插件依赖：`plugin-dependency-fixtures.test.ts`、`plugin-dependency-graph.test.ts`、`plugin-dependency-planner.test.ts`、`status-dependencies.test.ts` 和相关命令测试覆盖 manifest 合同、ledger edge、location-aware planner、自动安装、升级、卸载清理和 status 投影
- Runtime 环境变量：`tests/integration/runtime-env.test.ts` 覆盖 `AW_HOME`、`AW_CODEX_HOME`、`AW_CLAUDE_HOME` 等路径覆写
- 插件配置与脚本：`plugin-config.test.ts`、`plugin-scripts.test.ts`、`plugin-lifecycle-command.test.ts` 覆盖 AW config、lifecycle context/runner、status health 和命令接入

## Regression Contracts

CLI entry 测试优先通过 `CliRuntimeOptions` 注入 fake native runner、fake adapters、fake prompt、reporter 和 debug logger。不要为了普通集成测试依赖真实 `codex` 或 `claude` 可执行文件；只有明确验证 PATH 查找时才创建 stub binary。

插件依赖测试优先从纯函数层锁住行为，再接命令层。manifest 和作者工具 parity fixture 要覆盖合法 `dependencies.plugins`、未知字段、自依赖、非法 `when.platforms`、同名依赖平台条件重叠、非法 `target.scope`、`target.platform` 拒绝、`inheritInstallOptions` 类型，以及 catalog-level dependency reference validator。build smoke 需要断言 runtime `.agents-plugin/plugin.json` 保留 `dependencies`，`.claude-plugin/plugin.json`、`.codex-plugin/plugin.json` 和平台 marketplace manifest 不包含 `dependencies`。

planner 单测不要依赖真实 adapter 写文件，只用 catalog manifest、installed snapshot manifest、ledger fixture 和 health fixture。必须覆盖循环链路错误、缺失 catalog 依赖、平台 products 不匹配、当前 platform 不生效 entry 被过滤、直接依赖顺序稳定、多路径指向同一 location 只规划一次写入但保留多条 dependent edge，以及 install / upgrade / uninstall / status 共享 location identity。所有断言都应使用完整 `PluginLocation` 或 `serializePluginLocation()`，不能只按插件名判断。

location-aware scope 规则要有专门矩阵：user 父插件只能被 user scope 依赖满足；user 父插件遇到生效的 `target.scope: "project"` 要在写前失败；project 父插件省略 `target.scope` 时优先当前 project，允许 fallback 到健康 user；显式 `target.scope: "user"` 不能被 project 满足；显式 `target.scope: "project"` 不能 fallback user；其它历史 project 不能满足当前 project 依赖。Codex project 自动依赖还要复用 project installability，覆盖 native-only、`apps` 和缺少 repo-managed surface 的拒绝路径。

ledger 依赖图测试要断言只持久化 outgoing `dependencyEdges` 和 `installSource`。incoming dependents index、`dependents`、ref-count 和 `autoRemovable` 都必须从图上现算，不能落盘。重复 install、重复 upgrade、install 后 upgrade 要确认同一 dependent location + dependency location 只保留 canonical edge；显式安装一个 auto dependency 后要把 explicit 保留标记写回，父插件卸载不能自动删除它。ledger degraded、缺少 dependency metadata、edge 不完整或 tracking identity 损坏时，自动清理必须 fail closed。

写命令测试要覆盖拓扑顺序和失败收口：`install` 先完成 graph-level preflight，再依赖优先写入；已满足依赖不重复安装但刷新父插件 edge；缺 required config 的自动依赖要指向依赖插件和 key；`inheritInstallOptions: true` 只影响自动安装依赖，冲突时 fail fast；父插件失败时未被成功 edge 引用的新 auto dependency 要回滚，已被其它成功 dependent 引用的不能误删。`upgrade <plugin>` 必须先处理依赖再升级父插件；`upgrade --all` 只以 explicit 保留安装为根，不把孤立 auto dependency 当根，旧 edge 中已不需要的 auto dependency 不阻塞父插件升级。

uninstall 依赖测试要覆盖仍有 incoming dependent 时拒绝卸载、同命令卸载完整 dependent 集合、父插件卸载后反向拓扑清理引用归零的 auto dependency、explicit 保留的自动依赖不清理，以及 cleanup action 在 receipt 中使用 `uninstallAutoDependency`。跨 scope 和跨 platform 场景要断言 Codex / Claude、user / 当前 project / 历史 project 互不串线。

status 和控制台依赖投影测试要保持只读：不得创建 `~/.aw`、不得修复 ledger、不得运行 renderer/lifecycle、不得执行自动清理。`aw status --json` 要锁住 `dependencies.declared`、`resolved`、`satisfied`、`missing`、`dependents`、`autoInstalled`、`autoRemovable`、`catalogDrift`；当前 platform 不生效的 entry 只进入 `declared`，纯 catalog drift 不打坏 ready，缺失当前健康层依赖进入 `needsAttention`，可清理 auto dependency 只展示下一步动作。

主控制台测试默认必须使用 fake prompt / fake console driver，且断言不会访问真实 stdin。窄例外只允许放在专门验证 readline prompt harness、TTY sink 或隐藏敏感输入的测试里；这类测试必须显式隔离 stdin/stdout/stderr，并证明 `--json` stdout 仍是单一可解析 JSON。`runCli([])` 在 TTY 环境进入控制台；非 TTY、`CI=true` 或 prompt 不可用时不能挂起，必须返回清晰错误、可复制命令示例和 `--json` 提示。子命令即使注入 fake prompt 也不能 prompt。

主控制台安装、升级、配置、卸载、取消和诊断流程都要通过 fake prompt 覆盖。prompt adapter 要覆盖 `select`、`confirm`、`input`、`password`、滚动列表、返回和取消结果；非法 candidate id、过期 token、候选外插件名、skip/空值或非法 skill trigger 都要在 runtime 层拒绝。配置向导 fake prompt 要返回 `selectedScope`、`updates`、`removeKeys`、`updatedKeys`、`removedKeys` 和 `cancelled`；显式位置不能被 prompt 改写到另一层。切换写入层时只 patch dirty key，不能把 effective config 的整份 values 写入目标 store；取消时不能创建或修改任何 store。

主控制台安装向导需要覆盖平台兼容性和可安装性：`marketplace.policy.products` 过滤、`both` 下单平台插件禁用、显式多插件名共同兼容平台交集、无共同兼容平台时 dispatch 前失败，以及 fake prompt 返回不兼容平台时的拒绝。`Codex + project scope` 还要覆盖 repo-managed 候选过滤、空态、显式插件名早失败和正向可选插件；skills-only、mcp-only、slashCommands-only 应可选，apps-only 不进入候选，apps-mixed disabled 且指向 user scope 或拆分插件。

主控制台 Codex project scope 测试不能只依赖 native executable availability。PATH 缺少 `codex` 且未设置 `AW_FORCE_CODEX_AVAILABLE` 时，`aw` 仍要能展示并选择 Codex project repo-managed 候选；已有 Codex project repo-managed evidence 时，卸载和升级动作的目标选择也必须包含 Codex。Claude 可用、Codex executable 不可用的混合环境要单独覆盖，断言 Codex project repo-managed 选项不会被隐藏。

degraded ledger 下，重复 `install` 和显式插件 `upgrade` 要覆盖主控制台补问 `skill-trigger`、脚本化确定性错误、`CI=true` 不 prompt，以及非法 prompt 返回值。`--skill-trigger` CLI entry 回归要覆盖显式 `install`、显式插件 `upgrade` 的 `manual|auto|default` 正向透传，也要覆盖 `upgrade --all --skill-trigger` 和 `upgrade -a -t` 在入口层确定性拒绝。

Codex project 的 `skillTriggerApplicability` 要单独覆盖 `none`、`fixed`、`overridable`：mcp-only / extensions-only 不需要 ledger 偏好，公共 `slashCommands` 生成的 manual-only skill 属于 fixed，只有 overridable target 在 tracking-only 且缺少可恢复 install options 时拒绝显式 install/upgrade；`upgrade --all` 对这类 target 记为 `installOptionsUnavailable`。

Codex native marketplace 测试使用 fake native runner 断言 invocation 精确为 `codex plugin marketplace add <canonical AW_HOME>`。source 必须是 marketplace 根目录，不是 `.agents/plugins/marketplace.json`；local source 不带 `--ref`、`--sparse`，也不要求 `.tmp/marketplaces/aw` 存在。失败分支要覆盖 stderr、空输出、timeout、`ENOENT` 和 PATH 异常。marketplace add 或 verify 失败时，不能继续启动 app-server install RPC。

Codex user native install/uninstall 测试必须使用 fake Codex app-server harness，不依赖真实 `codex app-server`。harness 要覆盖 JSONL stdio 顺序 `initialize -> initialized -> plugin/install|plugin/uninstall`，可注入 stderr、unknown method、invalid request、plugins disabled、install policy denied、protocol error、early exit 和 spawn failure。`install` 正向路径要断言 app-server 写入 enabled config 和 materialized cache；post-check 缺任一侧都必须失败，并且不能出现 config-only fallback。`uninstall` 正向路径要断言通过 `plugin/uninstall` 清掉 config entry 和 active cache；如果 RPC 成功但 disabled config entry、enabled config 或 cache 仍残留，命令必须失败。

Codex native state / recovery helper 测试要覆盖 enabled-only、cache-only、shared-ref-only、breadcrumb-only、无效 cache 根、多版本 cache、非目录 cache entry、breadcrumb 独立于 `installed.json`、`aw init --force` 后 breadcrumb 保留，以及 marketplace cleanup 只有在 shared refs、breadcrumb、enabled config 和 active cache 都消失后才允许删除 `[marketplaces.aw]`。`aw status --json` 必须锁住 `native.pluginInstalled` 表示 cache installed、`native.pluginEnabled` 表示 config enabled，以及 `native.recovery.present/state/reason/evidenceMatches/suggestion` 的空值和非空值。

Codex native recovery 命令测试要覆盖 native write 成功后先写 `pending_after_native_write` breadcrumb，再进入 post-check、snapshot、lifecycle、tracking 和 ledger。breadcrumb 写入失败时立即失败，不写成功 ledger，也不承诺自动 repair / uninstall；breadcrumb 已落盘后续失败时，status 显示 partial / `needsAttention`，repair install 能补齐 AW 账本并删除 breadcrumb，breadcrumb-only uninstall 能清 config/cache/breadcrumb 且不运行 uninstall lifecycle。breadcrumb-only install 在 current catalog 找不到插件时要失败并提示 `aw uninstall <plugin> -p codex -s user`；breadcrumb-only upgrade 要明确失败，`upgrade --all` 要 skipped。

debug event 断言要按事件类型锁核心 payload，而不是只看人类输出。`native:marketplace` 至少断言 `platform`、`scope`、`plugin`、`marketplaceName`、`marketplacePath`、`operation`、`phase`；`native:rpc` 至少断言 `pluginId`、`method`、`phase`、`durationMs` 和失败时的 `errorCategory` / `suggestion`；`native:recovery` 至少断言 `operation`、`state`、`nativeWriteSucceeded`、`recoveryBreadcrumbPersisted`；`native:post-check` 至少断言 `operation`、`pluginEnabled`、`configEntryPresent`、`pluginInstalled`、`activeCachePath`；`native:skipped` 对 Codex project repo-managed target 必须断言 `reason=project_repo_managed_skipped_native`、`requiresNativeRuntime` 和 `repoManagedArtifactKinds`。

Codex project repo-managed 写命令要有 CLI output 回归：pure project install / uninstall / explicit upgrade 不得输出 native marketplace add 或 plugin enabled 成功信息；成功 receipt 要点名 `.agents/skills`、`.codex/config.toml`、`.codex/hooks.json`、`.codex/rules`、`.codex/agents` 中实际触达的目标面，并包含 tracking manifest 语义。默认 status 在正常 repo-managed 场景不能把用户级 marketplace 缺失作为主诊断；external ownership 只能作为附加诊断和 next step。

Codex project repo-managed 测试还要断言缺少 `codex` 可执行文件时不会调用 marketplace add、app-server RPC，也不会写用户级 config/cache；对应 command event 应为 `native:skipped` 且 reason 为 `project_repo_managed_skipped_native`。纯 native-only 插件和包含 `apps` 的 Codex project 安装要在写任何 repo artifact 前 fail fast。

Codex project required config 顺序要用零写入 helper 锁住：project installability、用户级 Codex config external ownership、必要的 project `.codex/config.toml` 解析、tracking identity 和 unmanaged repo artifact 冲突都必须早于 required AW config 表单 / store 写入。安全预检失败时，主控制台不调用 required config 表单，不创建 config store，不写 native state、artifact、tracking 或 ledger。同一条 mixed explicit command 里同一插件只解析一次 required config，主控制台同一轮只展示一次配置表单。

Codex project MCP 回归要覆盖结构化 JSON 到 TOML 的 round-trip、`null` fail fast、删除 stale descendant tables、同名 unmanaged 冲突，以及 quoted key 身份。tracking 里的 `artifactKey` 必须等于 rendered `.mcp.json` 的原始 server key，例如 `acme.tools v1`；测试要断言 `[mcp_servers."acme.tools v1"]` 不被当成嵌套路径。

repo 子目录回归要分别覆盖 discovery、status、主控制台 `uninstall/upgrade` 动作：Codex project scope 证据锚定 repo root realpath；Claude project scope 证据锚定调用目录 realpath，不能混入 repo root 或兄弟目录。

historical placeholder 回归要覆盖 discovery、默认 status、主控制台 `uninstall/upgrade` 候选。Codex ledger-only 的 `hasRepoManagedArtifacts: true` 不能恢复 hook、instruction、permission、agent 等具体 kind；tracking 明确记录 `kind: "hook"` 或 hook identity 时，才允许恢复 hook 能力。

status 测试要把默认、verbose、JSON、debug 通道分开锁住。默认 `aw status` 只展示友好摘要、位置和下一步，不泄露内部禁词；`aw status -j`、`aw status -j --verbose`、`aw status -j --debug`、`aw status -j --verbose --debug` 的 stdout 都必须用 `JSON.parse` 验证纯度，并断言旧矩阵字段以及新增 `ok`、`command`、`friendlySummaries`、`consoleItems` 都可用；verbose/debug 人类诊断只能出现在 stderr 或 debug log。unknown plugin 在 status 中应是 `notInstalled`，但执行型命令仍应报 `Unknown plugin`。

status skill-trigger 状态矩阵要覆盖 matched、equivalent defaults、mixed、drift、unknown 和 historical fallback，并分别断言默认视图不暴露 raw 字段名、verbose 可读展开、JSON 保留稳定机器字段。

友好状态投影测试要覆盖六类首屏状态、全部原因码、跨位置汇总、状态优先级、保守升级判定、Codex enabled-only / cache-only / breadcrumb-only、native recovery、无归属 native residue、dynamic artifact refresh failed、disabled by config 和 session visibility。action 安全不变量必须锁住：`PluginConsoleItem.actions` 不包含任何立即写状态的动作或隐式批量写动作；`runInstall`、`runUpgrade`、`runUninstall`、`repairInstall`、`cleanupRecovery`、`reapplyConfigRefresh` 只能出现在 `locations[].actions[]`；所有写动作都有完整 target，project 动作需要时带 `projectKey`；删除、覆盖和 cleanup 动作都有 `destructive: true` 和 `confirmText`；disabled 动作带 `disabledReason`。

stale 本地 marketplace 回归要断言 status 完全只读：`~/.aw` 缺失、`config.json` stale、marketplace 布局损坏或 ledger degraded 时，status 只读回退 embedded catalog；`--verbose` / `--json` 能看到 `source=embedded` 和本地目录不可用原因；测试要用文件存在性、mtime 或内容快照确认不会创建插件目录、修复 `~/.aw`、改写 `installed.json`、tracking manifest 或平台配置。

runtime env 贯穿测试要覆盖 direct command 与 `runCli(..., { env })` 两条入口。平台检测、ledger/current catalog 解析、home 路径、默认 adapter 创建、discovery 和 status 读取路径都必须消费注入 env，防止新 helper 悄悄回落到 `process.env`。

reporter/debug log 回归要覆盖 JSON receipt、默认输出稳定、中文 warning 有序去重、prepare / replay warning 先于 terminal error 输出、同一 prepare warning 一次命令只渲染一次，以及 debug log 对 token、password、secret、authorization、cookie 等敏感内容脱敏。写命令 `--json` stdout 必须是单一可解析 JSON，至少包含 `{ ok, command, warnings, nextSteps }`；`config set/unset/reset --json` 要锁住 `updatedKeys`、`removedKeys`、`artifactRefresh`，失败路径 stdout 为空或仍是单一 JSON，错误只在 stderr。默认输出不得出现 marketplace、app-server、RPC、cache、recovery breadcrumb、repo-managed、ledger、healthSource、artifactRefresh、sessionVisibility、projectTrust、tracking、config/script health 等禁词；可复制命令、argv、flag、JSON 字段和类型名是例外。`aw status --debug` 未传 `--log-file` 时不能创建或清理 `~/.aw/logs`。

AW config 回归要覆盖 default < user < project 的 effective 合并、未安装插件预配置、uninstall 保留配置、current catalog 缺失时 `reset --yes` 清理 raw store、非法插件名路径段拒绝、unknown keys 脱敏保留、`file` / `directory` 写入 realpath 和读取时重校验。config store 不能作为 discovery/status 的安装证据。

config write helper 和 refresh-only 回归要覆盖 `updates` / `removeKeys` 混合写入、sensitive 值不进入输出或 receipt、命中 refresh key 后 `artifactRefresh.triggerKeys` 与变更 key 对齐、refresh succeeded / failed / skipped 三态，以及 `reapplyConfigRefresh` 不修改 config store。refresh-only 成功后要更新 `lastRefresh` 和 tracking 诊断；失败后保留配置，并让后续 `aw status --json` / `aw status --verbose` 读到新的 `artifactRefresh.error`；没有 tracked dynamic artifact 时返回 skipped。

lifecycle 回归要覆盖 install/upgrade/uninstall 执行时机、失败阻断、`--script-timeout` 优先级、stdout/stderr 脱敏、Windows/POSIX env 分支、安装快照真值和快照 GC。status health 必须只读：它能展示 `healthSource`、config/script health 和 `invalid-config`，但不能执行脚本、刷新 marketplace、创建配置目录或修复 ledger。

`scripts.node` 相关测试要保持分层。unit/integration 默认使用 build-free synthetic embedded root，不运行 package manager、不执行 manifest build、不扫描真实 production dependency closure。真实 `pnpm install --frozen-lockfile --ignore-scripts`、manifest build、production `node_modules` 复制、runtime dependency install script 拒绝和 bundle layout 验收进入 smoke 或 opt-in runner，例如 `pnpm test:smoke:plugin-scripts`。

`pnpm plugin:test <plugin>` 运行单个插件时不处理其它坏插件；`pnpm plugin:test --all` 才会被任一插件失败阻断。runner 在临时 bundle、隔离 `AW_HOME` 和受管临时 project root 中执行 Node 测试；无 `scripts.tests.node` 匹配时输出 skipped/no tests matched 并以 0 退出，不调用 Node 默认测试发现。`--platform both` 要验证 Codex/Claude 两轮使用独立可写 bundle；测试入口从最终测试基准 manifest 的 glob 发现，test-only helper 由静态 import/require 递归复制，不能覆盖 runtime helper。

公共 `slashCommands` 测试要同时覆盖 build、validate 和作者工具文档：合法示例生成 Claude `commands/*.md` 与 Codex manual-only skill；Codex 生成的 `agents/openai.yaml` 固定 `policy.allow_implicit_invocation: false`；`./assets/...` 图标只复制被引用资源；嵌套命令目录、非法图标路径、Codex 渲染残留 `$ARGUMENTS` / `$1` / 命令结果填充语法都必须失败。

`upgrade --all` CLI entry 和 direct command 都要覆盖 skipped 合同。10 个稳定 code（`scopeNotInitialized`、`codexProjectUserConfigUnreadable`、`externalOwnershipUnknown`、`externalOwnershipPresent`、`trackingIntegrityError`、`installOptionsUnavailable`、`catalogNotCurrent`、`catalogNotProjectInstallable`、`projectConfigUnreadable`、`unmanagedRepoArtifactConflict`）必须有 direct 返回值断言、人类 receipt 断言和退出码断言；部分成功部分 skipped 退出 `0`，全部 skipped 且无成功升级退出 `1`。

## Pre-commit Checklist

- 改命令分支、catalog 判定、账本、bundle 生成或打包行为 → 至少运行相关测试
- 改 build 或 tarball 行为 → 补跑 `pnpm test:smoke:build`，必要时再跑 `pnpm test:smoke:pack`
- 改 `scripts.node` staging、manifest build、runtime dependency closure 或 `pnpm plugin:test` → 补跑 `pnpm test:smoke:plugin-scripts`；维护具体插件脚本时可先跑 `pnpm plugin:test <plugin>`
- 本地开发验证安装链路 → 执行 `make local-install`；如需刷新本机 marketplace，再补 `aw init --force`
- 测试版发包 → 执行 `make beta-release VERSION=x.y.z-beta.n`；它会同步两个 `package.json` 版本号，跑完整校验，并发布 `beta` dist-tag
- 正式发包 → 优先执行 `make release VERSION=x.y.z`；它会同步两个 `package.json` 版本号，先跑完整校验并验收 tarball，再发布 `latest`
- 已经手动同步好稳定版本，只想走旧脚本入口时 → 执行 `pnpm publish:cli`；它不会改版本号，只会校验并发布当前版本
- 改 plugin manifest contract、本地 marketplace 布局或作者工具 → 同步更新对应 fixture、样例插件和相关文档
- 只改公开文档 → 不必跑全量测试，但要至少检查 `AGENTS.md`、`README.md`、`docs/*.md` 没有继续引用过期路径或把 `docs/dev` 当作公开权威来源
