# Testing Guidelines

测试框架 Vitest。常规测试文件使用 `*.test.ts`；独立性能目录 `packages/cli/tests/perf/` 还包含 `*.test.mjs` gate 回归。其它测试材料位于 `packages/cli/tests/` 下的 `unit/`、`integration/`、`smoke/`、`helpers/`、`fixtures/`。

## Test Layers

- **`unit/` 和 `integration/`** — 保持 build-free，不依赖预先存在的 `plugins-dist`；需要 runtime bundle 输入时，用 `tests/helpers/embedded-root.ts` 生成临时 synthetic embedded root
- **`pnpm test:unit:fast`** — 运行显式 allowlist 中的纯逻辑 unit 文件，用于开发中的快速反馈；它不启动 child process、package manager 或 native CLI，也不构造大规模 artifact tree
- **`pnpm test:perf`** — 只运行 `tests/perf/` 下的独立性能预算和 gate 回归；它不进入普通 unit、integration 或 `pnpm test`
- **`pnpm test:perf:gate`** — 先运行性能 Vitest，再运行 `test:unit:fast` 并检查 fast lane 的 wall time；用于性能门禁
- **`smoke/`** — 专门验证 CLI build、CLI pack、sidecar/full catalog pack 和 catalog fetch 产物；这些入口通过 `build:ensure` 取得已验证构建，不进入常规 `pnpm test`
- **`pnpm plugin:test <plugin>`** — 插件作者脚本测试入口，先 compile CLI，再运行已编译的 `packages/cli/scripts/test-plugin-scripts.js`；它使用 build 后 staging manifest 判定支持平台，并准备临时 bundle，但不是 `aw` 客户端子命令
- **`pnpm plugin:eval <plugin>`** — Codex 插件 Skill 作者 eval 入口，按插件根 `evals/manifest.json` 经过真实 staging/renderer/adapter materialize project/user 制品；中央 native trigger driver 统一负责触发评测，领域专用 command runner 也只能消费最终制品；默认运行 release-required 模型 suite，`--materialize-only` 不调用模型
- **`node .agents/skills/skill-review/scripts/run_static_skill_evals.mjs <skill> ...`** — 当前仓库 `.agents/skills/<name>` 的静态 project Skill eval；不伪装成插件，也不增加 package script
- **`fixtures/repo-template/`** — 含 `.codex/`、`.claude/` 等完整项目结构示例
- **`fixtures/codex-config/`** — Codex 配置示例
- **`fixtures/codex-project-repo-managed/`** — Codex project scope repo-visible fixture 矩阵，覆盖 skills-only、mcp-only、slashCommands-only、skills+MCP、apps 拒绝、quoted-key MCP 和 project artifact identity

## Build Reuse

过去，测试和发布入口各自运行完整 build。同一条验证或打包链路可能重复编译 CLI，并重复生成 catalog staging。现在根脚本区分强制 build 和可复用 build：

- `pnpm build`：始终执行完整构建，并在成功后刷新 build stamp。修改或验证构建实现本身时使用此入口。
- `pnpm build:ensure`：先检查 stamp、构建输入和必要输出。全部匹配时复用现有产物；任一项失效时执行完整构建并刷新 stamp。只需要一个已验证构建输入的 smoke、pack 或 release 步骤使用此入口。

普通 `pnpm build:ensure` 只保证 canonical build 有效，不创建消费副本。需要在 ensure 返回后继续读取构建产物的 release 和 smoke 路径使用私有 build snapshot，避免并发强制构建改写 canonical 输出。真实强制构建仍由根 `pnpm build` 执行；`run-build.mjs` 传入 `force: true`。build-cache 单测覆盖 warm stamp 下的强制重建和 generation 刷新。

stamp 位于 `.release/cache/build-stamp.json`，schema version 为 `5`。每次真实构建生成新的 `generationId`；warm reuse 保留原 generation。一个 generation 同时绑定 `inputDigest`、`outputDigest` 和 `cliPackageDigest`。输入 identity 包含：

- 已登记输入树的 path、type、mode 和文件内容摘要。摘要使用无歧义的字段编码，并为每个 entry 单独计算 hash。
- Node 版本、Node executable 的路径、realpath 与内容摘要、`process.platform`、`process.arch`，以及根 `packageManager` 声明。
- 当前 pnpm launcher 的路径、realpath、内容摘要和 npm user-agent。构建使用已验证的 Node 与 pnpm realpath；缺少 `npm_execpath` 时失败。launcher 在构建前固定，构建后会比较全部 stamp identity；任一 identity 在构建期间变化都拒绝写 stamp。

`cliPackageDigest` 使用长度前缀的结构化 hash，绑定物化后的 regular `packages/cli/package.json` 的 type、path、referent mode 和 bytes。canonical package 即使是 symlink，也按 referent 的实际内容计算；该 symlink 仍会按输入 symlink 规则禁用 warm stamp。

输入扫描只排除明确无关内容：`.release`、`packages/cli/dist`、`packages/cli/plugins-dist`、任意 `node_modules`，以及 `plugins/<name>/evals/**`。插件源码内其它名为 `dist` 的目录仍是输入，内容变化会使 stamp 失效。`evals/**` 是作者期材料，不进入 production bundle，因此不触发重建。

stamp 还绑定 `packages/cli/dist/**` 和 `packages/cli/plugins-dist/**` 的完整输出树摘要。输出树中任意文件或目录增删、内容或 mode 改变，都会使复用失败。输出树出现 symlink 时拒绝复用和写 stamp。关键 marketplace、catalog 和 package JSON 另做结构校验。

如果任一已登记输入路径中存在 symlink，或任一插件 source manifest 声明 `scripts.node.build`，warm stamp 复用会禁用。`build:ensure` 会执行完整构建，但可以为本次调用返回经过摘要校验的临时 snapshot；不会把该结果写成可复用 stamp。插件 build 脚本可以读取自己的环境，因此 CLI 不把任意环境变量当作长期可复用 identity。

`.release/cache/build.lock` 用 direct `mkdir` 串行化强制构建、ensure 和 snapshot copy。锁不做自动 stale recovery。等待超时会报告 lock 和 owner 信息；恢复前必须停止全部相关 build、release 和 smoke 进程，再离线删除明确的 lock 或 intent 路径。

每个强制构建在 `buildWithCache()` 返回 Promise 前同步创建 `.release/cache/build.force/<token>` intent，然后等待 build lock。ensure 在锁内检查全部 intent；发现 intent 时释放 lock，等待 intent 清理，再重新检查。intent 不自动回收，强制构建成功或失败后只清理自己的 token。

私有 snapshot 位于 `.release/build-snapshots/build-*`。它在持有 build lock 时取得稳定 generation，把 canonical `package.json` referent 的 bytes 和 mode 写成普通文件，并复制 `dist` 与 `plugins-dist`。复制完成后会重新计算 canonical 完整 `inputDigest`、canonical `cliPackageDigest`、snapshot package digest 和 snapshot 输出摘要；任一值与本次 generation 不一致都会拒绝返回并清理 snapshot。canonical package symlink 的外部 target 后续变化不会改变已经物化的 snapshot package。

snapshot handle 返回 `generationId`、`outputDigest`，以及同一 generation 的 `inputDigest` 和 `cliPackageDigest`。除 `node_modules` directory symlink 或 Windows junction 外，snapshot 中不允许其它 symlink。这个依赖链接只提供 ESM 解析，不进入输出摘要或 tarball。snapshot 完成后释放 build lock；consumer 在锁外只读取 snapshot，后续 force 可以安全更新 canonical 输出。owner 在成功或失败的 `finally` 中清理自己的完整 snapshot；snapshot cleanup 不需要 build lock。

CLI pack 从 `snapshot.cliPackageRoot` 生成 tarball。组合 pack 和组合 publish 对 CLI 与 catalog 使用同一个 generation。Catalog prepare、pack、preflight 和 publish 使用同一 snapshot 的 compiled helper 与 catalog source；版本和 history 只写入 `.release/catalog-staging/catalog-*` 副本。CLI publish 发布已经生成的 tarball，不重新读取 workspace package。Release 和 smoke 都在结束时清理自己的 snapshot 与 catalog staging。

`build:ensure` 只复用通过这些检查的构建结果。它不是跳过 build 正确性的选项。需要证明“从当前输入重新构建”的测试必须用 `pnpm build`；只需要保证后续步骤消费有效产物时用 `pnpm build:ensure`。

## Performance Budgets

性能测试与普通功能测试分开。不要把性能用例放进 `tests/unit/`，也不要把 `pnpm test:perf` 当成功能正确性门禁。预算使用稳定名称输出 `AW_PERF_SUMMARY`，便于本地和 CI 收集：

| 预算 | 样本与指标 | 上限 |
|------|------------|------|
| `catalog-cache-first-warm` | 已验证磁盘 cache 的 warm `cacheFirst` 解析 P95 | `150 ms` |
| `console-warm-load` | 主控制台/status 真实 warm load chain P95 | `500 ms` |
| `catalog-remote-deadline` | `AW_CATALOG_REMOTE_TIMEOUT_MS=100` 时单次挂起远程解析的最大耗时 | `500 ms` |
| `unit-fast-wall` | `test:unit:fast` 单次 wall time，由 gate 编排器测量 | `30000 ms` |

前三项由 `pnpm test:perf` 执行。`unit-fast-wall` 由 `pnpm test:perf:gate` 在性能 Vitest 通过后执行。gate 还有独立 hard timeout，用于终止异常挂起；hard timeout 不是性能预算。进程树清理的 POSIX 和 Windows 路径分别有可注入回归，覆盖正常退出和 timeout 清理。

## Focus Areas

- CLI 命令入口：`tests/integration/cli-entry.test.ts` 覆盖 commander 参数、stdout/stderr 和退出码
- 命令编排与平台行为：`tests/integration/cli.test.ts`、`upgrade-command.test.ts`、`skill-trigger-command.test.ts`
- 作者工具：`tests/integration/authoring-tools.test.ts` 覆盖脚手架、校验脚本和作者文档关键约定
- 插件依赖：`plugin-dependency-fixtures.test.ts`、`plugin-dependency-graph.test.ts`、`plugin-dependency-planner.test.ts`、`status-dependencies.test.ts` 和相关命令测试覆盖 manifest 合同、install record edge、dependency index、location-aware planner、自动安装、升级、卸载保护和 status 投影
- 版本管理与 catalog：`manifest.test.ts`、`plugin-catalog.test.ts`、`plugin-catalog-resolvers.test.ts`、`local-marketplace.test.ts`、`command-options.test.ts`、`command-receipt.test.ts`、`status-command.test.ts`、`config-write.test.ts` 和 smoke 矩阵覆盖 CLI / catalog / plugin 三套版本身份、sidecar/full manifest 一致性、history、selector、cache fallback、latest blocked、active view、historical runtime 和 config schema source
- Runtime 环境变量：`tests/integration/runtime-env.test.ts` 覆盖 `AW_HOME`、`AW_CODEX_HOME`、`AW_CLAUDE_HOME` 等路径覆写
- 插件配置与脚本：`plugin-config.test.ts`、`plugin-scripts.test.ts`、`plugin-lifecycle-command.test.ts` 覆盖 AW config、lifecycle context/runner、status health 和命令接入

## Test Isolation

`unit/`、`integration/` 和 `smoke/` 默认加载统一测试隔离 setup。每个用例开始前都会生成唯一安全 root 和 env，覆盖 `HOME`、`USERPROFILE`、`AW_HOME`、`AW_CODEX_HOME`、`AW_CLAUDE_HOME`、XDG、npm userconfig、`TMPDIR` / `TEMP` / `TMP` 和 debug log 路径，并把全局 `process.cwd()` 切到安全 `fixture-cwd`。setup 只预建运行前必需的 `fixture-cwd`、临时目录和 npm user config；其它状态目录由业务代码在需要时创建。未显式 stub 的 `fetch` 默认失败；catalog source、embedded root、catalog memo、fetch stub、env/cwd overlay、native guard 和 app-server guard 会在用例间统一恢复。常规测试不要手写保存/恢复 `process.env`、`process.chdir()`、catalog override 或 embedded root override；只清理测试自己创建的业务状态。

smoke 内的真实 pnpm 子进程通过当前测试进程的 `npm_execpath` 启动，即 `process.execPath <npm_execpath> ...`。它不调用 PATH 中的 `pnpm` 或 Corepack shim，因此不会因 Corepack 在线下载而阻断；缺少 `npm_execpath` 时会立即报错，并提示通过 pnpm 运行测试。

CLI 测试优先使用安全入口。CLI entry 用 `runCliEntry()`，直接调用 CLI runtime 用 `runSafeCli()` 或 `createSafeCliRuntimeOptions()`，命令上下文用 `createSafeCommandExecutionContext()` / `createSafeCliExecutionContext()`。这些 helper 会注入安全 env/cwd、捕获 IO、默认 native guard 和默认 app-server guard；显式传入 env、cwd 或 runner 时仍会走 fence / guard 校验。只有专门验证生产默认值时才直接调用 `runCli()`、`createCommandExecutionContext()` 或 `createCliExecutionContext()`，并在测试名和断言里说清楚原因。

路径 fence 区分只读 fixture 根和可写状态根。显式创建的 temp root、可变项目 fixture、写入型 project cwd 和 staging 目录要登记为可写根，例如 `registerCurrentTestWritableStateRoot()`、`registerCliTempRoot()`、`registerCliFixtureRepoRoot()` 或 `withCurrentTestSafeCwd()`。embedded root、catalog source、真实仓库源码、repo fixture、build/dist/pack 输入等只作为输入读取时登记为只读根，例如 `registerCurrentTestReadonlyFixtureRoot()`、`registerCliEmbeddedRoot()`、`registerCliCatalogSourceRoot()`、`registerCliDistInputRoot()` 或 `runWithCurrentRepositoryCwdAsReadOnly()`。同一路径既要读又要写时，必须分别表达两个意图；只读根不会自动获得写权限。

全局 cwd 由 setup 接管。需要临时进入真实仓库只读检查时，用 `runWithCurrentRepositoryCwdAsReadOnly()` 包住最小代码块；需要可写 project scope 时，用 `createCliTestWorkspace()`、`withCurrentTestSafeCwd()` 或先登记可写根。不要把真实仓库 cwd 当成 project-scope 写入目标，也不要在测试里裸 `process.chdir()` 后靠 `afterEach` 手动恢复。

测试默认禁止真实 native CLI 和真实 `codex app-server`。需要断言 native 行为时，向 safe helper 传入 fake `nativeCliRunner`，并检查 command、args、cwd 和 env；不要依赖本机已安装 `codex` / `claude`。Codex user-scope native install/uninstall 用 fake native runner 覆盖 `codex plugin marketplace add/list/remove` 和 `codex plugin add/remove`。Codex app-server 只用于 verbose/native view 诊断测试，通过 `codexAppServerRunner` 注入 fake harness，并断言 `plugin/list`、`plugin/installed`、`plugin/read` 的 JSONL 协议和降级分支。只有验证 PATH 查找本身时才创建 stub binary。

zero-write snapshot 只用于事后证明“这条命令不应写状态”。`captureZeroWriteSnapshot()`、`assertZeroWriteSnapshotUnchanged()` 和 `runWithZeroWriteSnapshot()` 可以覆盖 `.agents`、`.codex`、`.claude`、AW config store、install record、native config/cache 等目标，但它们不能替代 fence 或 guard。漏传 env、cwd、根注册、native runner 或 app-server harness 的错误，应先由 fence / guard 在写入或启动进程前暴露；zero-write 只作为补充回归。

## Regression Contracts

CLI entry 测试优先通过 `runCliEntry()` 或 `runSafeCli()` 注入 fake native runner、fake adapters、fake prompt、reporter 和 debug logger。不要为了普通集成测试依赖真实 `codex` 或 `claude` 可执行文件；只有明确验证 PATH 查找时才创建 stub binary。

install-state fixture 要能按 location 单独构造 record v2、dynamic diagnostic cache、project artifact identity、dependency index、historical lifecycle runtime、native transaction marker 和 shared runtime owner。损坏矩阵至少覆盖：单条 record 损坏不影响同 scope 其它插件、diagnostic cache 损坏只降低动态 artifact 诊断确定性、identity metadata 损坏阻止 `install --adopt-existing`、dependency index unreadable / stale 时删除默认 fail closed、Codex user scope 只剩 enabled config 且没有 cache/record/marker 时允许 cleanup 收口、historical lifecycle runtime 缺失时普通卸载需要明确诊断、native marker-only 可以被 cleanup 收口或由重试 install 重新走写入链路、shared owner record digest 不匹配时不自动重选 owner。project private state 和 project local config fixture 必须默认被 ignore；project shared config 和 project artifact identity fixture 不能默认 ignore。

插件依赖测试优先从纯函数层锁住行为，再接命令层。manifest 和作者工具 parity fixture 要覆盖合法 `dependencies.plugins[].minVersion`、未知字段、自依赖、非法 `when.platforms`、同名依赖平台条件重叠、非法 `target.scope`、`target.platform` 拒绝、`inheritInstallOptions` 类型、旧式 `version` / `range` 拒绝，以及 catalog-level dependency reference validator。build smoke 需要断言 runtime `.agents-plugin/plugin.json` 保留 `dependencies`，`.claude-plugin/plugin.json`、`.codex-plugin/plugin.json` 和平台 marketplace manifest 不包含 `dependencies`。

版本管理回归必须覆盖这些矩阵：

- SemVer：CLI version、catalog version、catalog minAwVersion、plugin version、plugin minAwVersion、dependency minVersion、installed resolvedVersion 都使用严格 SemVer；非法值在比较前失败，build metadata 不触发升级。
- Manifest / catalog：插件缺失 `compatibility.aw.minVersion`、插件最低 CLI 版本高于 catalog 门槛、非法 `dependencies.plugins[].minVersion`、旧式 `version` / `range` 字段、同一 catalog 内重复插件名、sidecar/full manifest 不一致都要失败。
- 发布轨道：`latest` 拒绝 prerelease catalog version 和 prerelease 插件 version；`beta` 要求 prerelease catalog version，允许 stable / prerelease 插件混合；同一 catalog version 不能跨轨道复用。
- History / digest：sidecar history releases 包含 catalog version、catalog minAwVersion、插件 version、插件 minAwVersion、`artifactDigest` 和 `manifestDigest`；同一 `plugin@version` digest 改变、仅 build metadata 替代、artifact 改变但插件 version 未递增都要被发布门禁阻断。
- Selector / cache fallback：默认 channel、显式 dist-tag、显式 exact version 三类 selector 互斥并隔离 cache；latest blocked 后 history 不可用固定为 `catalogHistoryUnavailable`，history 确认无兼容版本固定为 `awVersionTooLow`，不能被 cache fallback 推翻；只有已解析出允许使用的 catalog identity 后，远程失败才可命中匹配 cache。
- `aw init`：只预热 catalog/cache，不安装、不升级、不写 install record、不 materialize active view；`--force` 不删除仍被 install record、project artifact identity、dynamic diagnostic cache 或 native recovery marker 引用的 historical runtime。
- Active view / historical runtime：user-scope native 写命令调用平台前必须 materialize 并校验 active local marketplace/runtime view，元数据包含 selector、channel、catalog version、minAwVersion、sidecar identity、digest 和写入 CLI version；成功 install/upgrade/reinstall 在提交成功 record 前持久化可校验 historical runtime。
- Config schema / reset：已安装位置优先使用 historical schema；未安装 schema 路径需要 current catalog；schema conflict 阻断 `set/unset`，`config reset` 对已消费 store 暴露 `removedKeys` 和 `artifactRefresh`，orphan store raw 删除不伪造 schema identity。

planner 单测不要依赖真实 adapter 写文件，只用 catalog manifest、install record fixture、dependency index fixture、project artifact identity fixture 和 health fixture。必须覆盖循环链路错误、缺失 catalog 依赖、平台 products 不匹配、当前 platform 不生效 entry 被过滤、直接依赖顺序稳定、多路径指向同一 location 只规划一次写入但保留多条 dependent edge，以及 install / upgrade / uninstall / status / cleanup / reinstall 共享 location identity。所有断言都应使用完整 `PluginLocation` 或 `serializePluginLocation()`，不能只按插件名判断。

location-aware scope 规则要有专门矩阵：user 父插件只能被 user scope 依赖满足；user 父插件遇到生效的 `target.scope: "project"` 要在写前失败；project 父插件省略 `target.scope` 时优先当前 project，允许 fallback 到健康 user；显式 `target.scope: "user"` 不能被 project 满足；显式 `target.scope: "project"` 不能 fallback user；其它历史 project 不能满足当前 project 依赖。Codex project 自动依赖还要复用 project installability，覆盖 native-only、`apps` 和缺少 repo-visible surface 的拒绝路径。

install record 依赖图测试要断言只持久化 outgoing `dependencyEdges` 和 `installSource`。incoming dependents index、`dependents`、ref-count 和 `autoRemovable` 都必须从 records / dependency index 现算，不能落盘。重复 install、重复 upgrade、install 后 upgrade 要确认同一 dependent location + dependency location 只保留 canonical edge；显式安装一个 auto dependency 后要把 explicit 保留标记写回，父插件卸载不能自动删除它。record 损坏、缺少 dependency metadata、edge 不完整、dependency index 不可信或 project artifact identity 损坏时，删除类命令默认必须 fail closed；但 Codex user scope 的 config-only 原生残留 cleanup 是例外，需要单独锁住。

写命令测试要覆盖拓扑顺序和失败收口：`install` 先完成 graph-level preflight，再依赖优先写入；已满足依赖不重复安装但刷新父插件 edge；缺 required config 的自动依赖要指向依赖插件和 key；`inheritInstallOptions: true` 只影响自动安装依赖，冲突时 fail fast；父插件失败时未被成功 edge 引用的新 auto dependency 要回滚，已被其它成功 dependent 引用的不能误删。`upgrade <plugin>` 必须先处理依赖再升级父插件；`upgrade --all` 只以 explicit 保留安装为根，不把孤立 auto dependency 当根，旧 edge 中已不需要的 auto dependency 不阻塞父插件升级。

uninstall 依赖测试要覆盖仍有 incoming dependent 时拒绝卸载、同命令卸载完整 dependent 集合、父插件卸载后反向拓扑清理引用归零的 auto dependency、explicit 保留的自动依赖不清理，以及 cleanup action 在 receipt 中使用 `uninstallAutoDependency`。跨 scope 和跨 platform 场景要断言 Codex / Claude、user / 当前 project / 历史 project 互不串线。

status 和控制台依赖投影测试要保持只读：不得创建 `~/.aw`、不得修复 record / dependency index、不得运行 renderer/lifecycle、不得执行自动清理。`aw status --json` 要锁住 `dependencies.declared`、`resolved`、`satisfied`、`missing`、`dependents`、`autoInstalled`、`autoRemovable`、`catalogDrift`、`dependencyIndexTrusted`；当前 platform 不生效的 entry 只进入 `declared`，纯 catalog drift 不打坏 ready，缺失当前健康层依赖进入 `needsAttention`，可清理 auto dependency 只展示下一步动作。

主控制台测试默认必须使用 fake prompt / fake console driver，且断言不会访问真实 stdin。窄例外只允许放在专门验证 readline prompt harness、TTY sink 或隐藏敏感输入的测试里；这类测试必须显式隔离 stdin/stdout/stderr，并证明 `--json` stdout 仍是单一可解析 JSON。`runCli([])` 在 TTY 环境进入控制台；非 TTY、`CI=true` 或 prompt 不可用时不能挂起，必须返回清晰错误、可复制命令示例和 `--json` 提示。子命令即使注入 fake prompt 也不能 prompt。

主控制台安装、升级、配置、卸载、取消和状态流程都要通过 fake prompt 覆盖。prompt adapter 要覆盖 `select`、`confirm`、`input`、`password`、滚动列表、返回和取消结果；非法 candidate id、过期 token、候选外插件名、skip/空值或非法 SkillTrigger 配置值都要在 runtime 层拒绝。配置向导 fake prompt 要返回 `selectedScope`、`updates`、`removeKeys`、`updatedKeys`、`removedKeys` 和 `cancelled`；显式位置不能被 prompt 改写到另一层。切换写入层时只 patch dirty key，不能把 effective config 的整份 values 写入目标 store；取消时不能创建或修改任何 store。

主控制台安装向导需要覆盖平台兼容性和可安装性：`marketplace.policy.products` 过滤、`both` 下单平台插件禁用、显式多插件名共同兼容平台交集、无共同兼容平台时 dispatch 前失败，以及 fake prompt 返回不兼容平台时的拒绝。`Codex + project scope` 还要覆盖 repo-visible 候选过滤、空态、显式插件名早失败和正向可选插件；skills-only、mcp-only、slashCommands-only 应可选，apps-only 不进入候选，apps-mixed disabled 且指向 user scope 或拆分插件。

主控制台 Codex project scope 测试不能只依赖“是否有 repo-visible surface”。写动作必须先通过 Codex `>= 0.145.0` 版本门禁；PATH 缺少 `codex`、版本不可解析或低于 `0.145.0` 时，安装、升级、卸载、cleanup、reinstall 和会刷新 artifact 的配置动作都不能写 repo-visible artifacts，也不能创建 record、marker 或用户级 native 状态。只读发现和状态页面可以展示 Codex project 候选或已有 project evidence，但必须把版本阻断作为写入前提展示。

SkillTrigger 回归要覆盖 manifest 默认策略、AW 内建配置、built-in apply pipeline、公开 JSON 投影和作者工具同步。`aw install`、`aw upgrade`、`aw reinstall` 的 help 不展示 `-t` 或 `--skill-trigger`，传入这些旧参数时确定性失败并引导到 `aw config` 或主控制台配置页。

SkillTrigger 内建字段要覆盖 `defaultTrigger`、`allowDynamicTrigger`、fixed 只读、ignored 历史覆盖、orphaned 旧配置、project local invalid 存量值和 config 写 receipt。`aw config list/get --json` 顶层必须包含 `configSchemaVersion: 2` 并以 `fields` 为主结构；`aw config set/unset/reset --json` 顶层必须包含 `receiptSchemaVersion: 2` 和 `affectedFields`。runtime 与 effective 配置不一致时，状态和 next steps 指向配置页或重新应用配置，不能提示 `--skill-trigger`。

Codex native marketplace 测试使用 fake native runner 断言 invocation 精确为 `codex plugin marketplace add <canonical AW_HOME>` / `codex plugin marketplace list` / `codex plugin marketplace remove`。source 必须是 marketplace 根目录，不是 `.agents/plugins/marketplace.json`；local source 不带 `--ref`、`--sparse`，也不要求 `.tmp/marketplaces/aw` 存在。失败分支要覆盖 stderr、空输出、timeout、`ENOENT` 和 PATH 异常。marketplace add 或 verify 失败时，不能继续执行 `codex plugin add`。

Codex user native install/uninstall 测试必须使用 fake native runner 覆盖 `codex plugin add/remove`，不依赖真实 Codex CLI。`install` 正向路径要断言 CLI 写入后 enabled config 和 materialized cache 都存在；post-check 缺任一侧都必须失败，并且不能出现 config-only fallback。`uninstall` 正向路径要断言 `codex plugin remove` 后 config entry 和 active cache 都被清掉；如果 CLI 成功但 disabled config entry、enabled config 或 cache 仍残留，命令必须失败。`codex app-server` 只用于 verbose/native view 只读诊断测试，fake harness 覆盖 `plugin/list`、`plugin/installed`、`plugin/read` 的 available / unavailable 分支，并断言失败降级为 `nativeViewUnknown`，不阻断 CLI 写入主链路。

Codex native state / marker helper 测试要覆盖 enabled-only、cache-only、shared-ref-only、marker-only、无效 cache 根、多版本 cache、非目录 cache entry、marker 独立于 install record、`aw init --force` 后 marker 保留，以及 marketplace cleanup 只有在 shared refs、marker、enabled config 和 active cache 都消失后才允许删除 `[marketplaces.aw]`。`aw status --json` 必须锁住 `native.pluginInstalled` 表示 cache installed、`native.pluginEnabled` 表示 config enabled，以及 native transaction marker 的空值和非空值。

Codex native marker 命令测试要覆盖 native write 成功后先写 `pending_after_native_write` marker，再进入 post-check、lifecycle、artifact apply、diagnostic cache 和 record commit。marker 写入失败时立即失败，不写成功 record，也不承诺自动 cleanup；marker 已落盘后续失败时，status 顶层只允许 `cleanupRequired` 或其它四态之一，并把 `nativeIncomplete` 放进 diagnostic / reason；marker-only cleanup 能清 config/cache/marker 且不运行 uninstall lifecycle。marker-only install 在 current catalog 找不到插件时要失败并提示先运行 `aw cleanup <plugin> -p codex -s user`；marker-only upgrade 要明确失败，`upgrade --all` 要 skipped。

debug event 断言要按事件类型锁核心 payload，而不是只看人类输出。`native:marketplace` 至少断言 `platform`、`scope`、`plugin`、`marketplaceName`、`marketplacePath`、`operation`、`phase`；`native:plugin` 至少断言 `pluginId`、`operation`、`phase`、`durationMs`、`nativeWriteSucceeded` 和失败时的 `errorCategory` / `suggestion`；`native:transaction` 至少断言 `operation`、`state`、`nativeWriteSucceeded`、`markerPersisted`；`native:post-check` 至少断言 `operation`、`pluginEnabled`、`configEntryPresent`、`pluginInstalled`、`activeCachePath`；`native:skipped` 对 Codex project target 必须断言 `reason=project_repo_managed_skipped_native`、`requiresNativeRuntime` 和 `repoManagedArtifactKinds`。

Codex project repo-visible 写命令要有 CLI output 回归：pure project install / uninstall / explicit upgrade 不得输出 native marketplace add 或 plugin enabled 成功信息；成功 receipt 要点名 `.agents/skills`、`.codex/config.toml`、`.codex/hooks.json`、`.codex/rules`、`.codex/agents` 中实际触达的目标面，并包含 project artifact identity 和 private state 分类。默认 status 在正常 project 场景不能把用户级 marketplace 缺失作为主诊断；external ownership 只能作为附加诊断和 next step。

Codex project repo-visible 测试还要断言通过版本门禁后不会调用 marketplace add/list/remove、`codex plugin add/remove` 或 app-server RPC，也不会写用户级 config/cache。缺少 `codex` 可执行文件、版本不可解析或版本低于 `0.145.0` 时，命令要在写任何 repo artifact 前 fail fast。纯 native-only 插件和包含 `apps` 的 Codex project 安装也要在写任何 repo artifact 前 fail fast。

Codex project required config 顺序要用零写入 helper 锁住：project installability、用户级 Codex config external ownership、必要的 project `.codex/config.toml` 解析、project artifact identity 和 unmanaged repo artifact 冲突都必须早于 required AW config 表单 / store 写入。安全预检失败时，主控制台不调用 required config 表单，不创建 config store，不写 native state、artifact、identity 或 record。同一条 mixed explicit command 里同一插件只解析一次 required config，主控制台同一轮只展示一次配置表单。

Codex project MCP 回归要覆盖结构化 JSON 到 TOML 的 round-trip、`null` fail fast、删除 stale descendant tables、同名 unmanaged 冲突，以及 quoted key 身份。artifact identity 里的 `artifactKey` 必须等于 rendered `.mcp.json` 的原始 server key，例如 `acme.tools v1`；测试要断言 `[mcp_servers."acme.tools v1"]` 不被当成嵌套路径。

repo 子目录回归要分别覆盖 discovery、status、主控制台 `uninstall/upgrade` 动作：Codex project scope 证据锚定 repo root realpath；Claude project scope 证据锚定调用目录 realpath，不能混入 repo root 或兄弟目录。

historical placeholder 回归要覆盖 discovery、默认 status、主控制台 `uninstall/upgrade` 候选。只有粗略 project 归属线索时，不能恢复 hook、instruction、permission、agent 等具体 kind；install record 或 project artifact identity 明确记录 `kind: "hook"` 或 hook identity 时，才允许恢复 hook 能力。

status 测试要把默认、verbose、JSON、debug 通道分开锁住。默认 `aw status` 只展示友好摘要、位置和下一步，不泄露内部禁词；`aw status -j`、`aw status -j --verbose`、`aw status -j --debug`、`aw status -j --verbose --debug` 的 stdout 都必须用 `JSON.parse` 验证纯度，并断言新增 `statusSchemaVersion: 2`、`consoleItemsSchemaVersion: 3`、`ok`、`command`、`friendlySummaries`、`consoleItems` 都可用；verbose/debug 人类诊断只能出现在 stderr 或 debug log。`statusSchemaVersion: 2` 管理 status envelope 和 verbose JSON 详细状态，`consoleItemsSchemaVersion: 3` 管理本轮 `consoleItems` summary shape、结构化 `nextSteps` 和 SkillTrigger 公共投影；`consoleItems` 不得泄露旧 action kind、旧 reason code、`statusIcon`、`statusTone`、`platformBadges`、`primaryActionLabel`、`targetOptions` 或 `availableTargets`。unknown plugin 在 status 中应是 `notInstalled`，但执行型命令仍应报 `Unknown plugin`。

status SkillTrigger 状态矩阵要覆盖 matched、fixed、ignored、orphaned、drift、missing runtime 和 historical fallback，并分别断言默认视图不暴露旧安装偏好字段、verbose 可读展开、JSON 使用统一 `SkillTriggerPublicView` 投影。

友好状态投影测试要覆盖四态顶层状态、首页 `异常/可升级/已安装/未安装` 分组、稳定 reason/diagnostic、跨位置汇总、状态优先级、保守升级判定、Codex enabled-only / cache-only / marker-only、native marker、无归属 native residue、project adopt-existing、shared owner conflict、dependency index untrusted、dynamic artifact refresh failed、disabled by config 和 session visibility。action 安全不变量必须锁住：公开 `PluginConsoleSummary.features` 只表达功能和目标选择策略，不包含 target、confirmText、command 或页面字段；执行层 `PluginConsoleExecutableAction` 只能在控制台完成功能和目标选择后生成，所有写动作都有完整 target，project 动作需要时带 `projectKey`；删除、覆盖和 cleanup 动作都有 `destructive: true` 和 `confirmText`；只有 `runCleanup` 可以生成 `force: true`；disabled 功能带 `disabledReason`。

stale 本地 marketplace / catalog cache 回归要断言 status 完全只读：`~/.aw` 缺失、旧 `sourceVersion + bundleFingerprint` 元数据、cache 布局损坏、install record 损坏或 dependency index 不可信时，status 不能回退 embedded catalog，也不能修复 `~/.aw`。`--verbose` / `--json` 要展示 catalog unavailable、legacy catalog metadata、selector、latest blocked 或 cache fallback 证据；测试要用文件存在性、mtime 或内容快照确认不会创建插件目录、改写 record、diagnostic cache、project artifact identity 或平台配置。

runtime env 贯穿测试要覆盖 direct command 与 `runCli(..., { env })` 两条入口。平台检测、install-state/current catalog 解析、home 路径、默认 adapter 创建、discovery 和 status 读取路径都必须消费注入 env，防止新 helper 悄悄回落到 `process.env`。

reporter/debug log 回归要覆盖 JSON receipt、默认输出稳定、中文 warning 有序去重、prepare / replay warning 先于 terminal error 输出、同一 prepare warning 一次命令只渲染一次，以及 debug log 对 token、password、secret、authorization、cookie 等敏感内容脱敏。写命令 `--json` stdout 必须是单一可解析 JSON，至少包含 `{ ok, command, warnings, nextSteps }`；`config set/unset/reset --json` 要锁住 `updatedKeys`、`removedKeys`、`artifactRefresh`，失败路径 stdout 为空或仍是单一 JSON，错误只在 stderr。默认输出不得暴露内部状态存储、低层 runtime 细节、debug-only 字段或诊断字段名；可复制命令、argv、flag、JSON 字段和类型名是例外。`aw status --debug` 未传 `--log-file` 时不能创建或清理 `~/.aw/logs`。

AW config 回归要覆盖 default < user < project 的 effective 合并、未安装插件预配置、uninstall 保留配置、current catalog 缺失时 `reset --yes` 清理 raw store、非法插件名路径段拒绝、unknown keys 脱敏保留、`file` / `directory` 写入 realpath 和读取时重校验。config store 不能作为 discovery/status 的安装证据。

config write helper 和 refresh-only 回归要覆盖 `updates` / `removeKeys` 混合写入、sensitive 值不进入输出或 receipt、命中 refresh key 后 `artifactRefresh.triggerKeys` 与变更 key 对齐、refresh succeeded / failed / skipped 三态，以及 `reapplyConfigRefresh` 不修改 config store。refresh-only 成功后要更新 `lastRefresh` 和 dynamic diagnostic cache；失败后保留配置，并让后续 `aw status --json` / `aw status --verbose` 读到新的 `artifactRefresh.error`；没有 dynamic artifact evidence 时返回 skipped。

lifecycle 回归要覆盖 install/upgrade/uninstall 执行时机、失败阻断、`--script-timeout` 优先级、stdout/stderr 脱敏、Windows/POSIX env 分支、historical lifecycle runtime 写入、缺失、损坏和 GC。status health 必须只读：它能展示 config/script health、historical lifecycle runtime 可用性和 `invalid-config`，但不能执行脚本、刷新 marketplace、创建配置目录或修复 record。

`scripts.node` 相关测试要保持分层。unit/integration 默认使用 build-free synthetic embedded root，不运行 package manager、不执行 manifest build、不扫描真实 production dependency closure。真实 `pnpm install --frozen-lockfile --ignore-scripts`、manifest build、production `node_modules` 复制、runtime dependency install script 拒绝和 bundle layout 验收进入 smoke 或 opt-in runner，例如 `pnpm test:smoke:plugin-scripts`。

`pnpm plugin:test <plugin>` 运行单个插件时不处理其它坏插件；`pnpm plugin:test --all` 才会被任一插件失败阻断。runner 会先准备 staging source，再从 build 后 staging manifest 解析最终支持平台：省略 `--platform` 时按 `both` 处理；`--platform auto` 必须失败并提示可选值是 `codex`、`claude` 或 `both`；显式 `claude` / `codex` 遇到任一选中插件最终不支持该平台时，必须在测试执行前失败；`both` 按每个插件最终支持平台集合展开，单平台插件只跑自己支持的平台，双平台插件分别跑 Codex 和 Claude 两轮。runner 在临时 bundle、隔离 `AW_HOME` 和受管临时 project root 中执行 Node 测试；无 `scripts.tests.node` 匹配时输出 skipped/no tests matched 并以 0 退出，不调用 Node 默认测试发现。双平台插件的 `--platform both` 要验证 Codex/Claude 两轮使用独立可写 bundle；测试入口从最终测试基准 manifest 的 glob 发现，test-only helper 由静态 import/require 递归复制，不能覆盖 runtime helper。

`pnpm plugin:eval` v1 只提供 Codex 证据，不进入常规 Vitest/CI。真实模型仅允许 project profile；user 和 dynamic non-default profile 通过 `--materialize-only` 验证最终文件、配置与 digest。默认无过滤参数时 materialize 所有 profile，并运行全部 `requiredForRelease` suite/split；`--suite`、`--profile`、`--split`、`--case`、`--runs` 只用于局部调试。使用任一选择器，或把 `--runs` 降到 suite 默认值以下时，bundle 固定为 `complete: false`、`outcome: incomplete`，命令退出 `1`，不能作为发布证据。输出的 `EvaluationBundle` 用 `passed`、`failed`、`needs_review`、`incomplete` 区分机械通过、失败、待人工定性和证据缺失；environment skip 始终保持 incomplete。

真实模型入口默认从当前 `CODEX_HOME/config.toml` 提取选中的 model/provider 到临时 runtime home。只保留模型选择和对应 `model_providers.<id>`，不会复制用户 plugins、skills、MCP 或 agents；`--model-provider`、`--codex-config` 可覆盖，`--no-inherit-codex-config` 使用干净官方 provider。provider 环境变量不能覆盖 HOME/CODEX_HOME/XDG/TMP/PATH/AW 等隔离边界，command runner 只继承固定白名单和 provider 显式变量；非官方 provider 一律不复制官方 auth。凭据变量排除出模型 shell，endpoint、token、header、provider env 和 auth token 在持久化前统一脱敏；临时 capsule 在成功、失败和 SIGINT/SIGTERM 后清理。

公共 `slashCommands` 测试要同时覆盖 build、validate 和作者工具文档：合法双平台示例生成 Claude `commands/*.md` 与 Codex manual-only skill；单平台插件只生成支持平台的命令产物；Codex 生成的 `agents/openai.yaml` 固定 `policy.allow_implicit_invocation: false`；`./assets/...` 图标只复制被引用资源；嵌套命令目录、非法图标路径、支持 Codex 时 Codex 渲染残留 `$ARGUMENTS` / `$1` / 命令结果填充语法都必须失败，Claude-only 插件不受 Codex forbidden syntax 限制。

`upgrade --all` CLI entry 和 direct command 都要覆盖 skipped 合同。稳定 code（`scopeNotInitialized`、`codexProjectUserConfigUnreadable`、`externalOwnershipUnknown`、`externalOwnershipPresent`、`projectArtifactIdentityError`、`installOptionsUnavailable`、`catalogNotCurrent`、`catalogNotProjectInstallable`、`projectConfigUnreadable`、`unmanagedRepoArtifactConflict`、`dependencyIndexUntrusted`、`sharedRuntimeOwnerConflict`）必须有 direct 返回值断言、人类 receipt 断言和退出码断言；部分成功部分 skipped 退出 `0`，全部 skipped 且无成功升级退出 `1`。

## Pre-commit Checklist

`pnpm test:unit:fast` 只用于局部开发反馈。提交前仍必须运行完整 `pnpm test:unit`；fast lane 不能替代完整 unit 门禁。

- 改命令分支、catalog 判定、账本、bundle 生成或打包行为 → 至少运行相关测试
- 改 catalog cache-first、主控制台 warm load、远程 deadline 或 fast lane 范围 → 运行 `pnpm test:perf:gate`；性能门禁不能替代相关 unit/integration 测试
- 改 build 或 tarball 行为 → 补跑 `pnpm test:smoke:build`，必要时再跑 `pnpm test:smoke:pack`
- 改 catalog 打包、sidecar/full manifest、history、selector/cache 或 fetch 行为 → 补跑 catalog pack/fetch smoke，以及相关 `plugin-catalog*`、`local-marketplace`、`command-options` 单测
- 改 `scripts.node` staging、manifest build、runtime dependency closure 或 `pnpm plugin:test` → 补跑 `pnpm test:smoke:plugin-scripts`；维护具体插件脚本时可先跑 `pnpm plugin:test <plugin>`
- 改 Skill、description、renderer/config 或 eval 基础设施 → 至少跑 `pnpm plugin:eval <plugin> --materialize-only`；真实 Codex suite 仅在需要行为或发布证据时本地显式运行
- 本地开发验证安装链路 → 执行 `make local-install`；如需刷新本机 catalog/cache，再补 `aw init --force`
- 测试版发包 → 执行 `make beta-release VERSION=x.y.z-beta.n`；它会分别验证 CLI 包和 beta catalog 包，catalog version / plugin prerelease 约束以发布脚本为准
- 正式发包 → 优先执行 `make release VERSION=x.y.z`；它会分别验证 CLI 包和 latest catalog 包；latest catalog 不允许 prerelease catalog version 或 prerelease 插件 version
- 已经手动同步好稳定版本，只想走旧脚本入口时 → 执行 `pnpm publish:cli`；它不会改版本号，只会校验并发布当前版本
- 改 plugin manifest contract、本地 marketplace 布局或作者工具 → 同步更新对应 fixture、样例插件和相关文档
- 改公开 JSON 合同 → 同步检查 `statusSchemaVersion: 2`、`consoleItemsSchemaVersion: 3`、`configSchemaVersion: 2`、`receiptSchemaVersion: 2`、`nextStepsSchemaVersion: 1` 的文档、测试和 CLI 输出
- 只改公开文档 → 不必跑全量测试，但要至少跑或说明未跑 `pnpm --filter @yiliang/aw exec vitest run tests/unit/public-docs.test.ts`，并检查 `AGENTS.md`、`README.md`、`docs/*.md` 没有继续引用过期路径或把 `docs/dev` 当作公开权威来源
