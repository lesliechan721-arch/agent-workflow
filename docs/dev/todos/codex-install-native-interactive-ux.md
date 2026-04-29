# Codex 安装修复、交互式模式与用户提示改进 TODO 拆解

## 文档说明

- 来源计划：`docs/dev/plans/codex-install-native-interactive-ux.md`
- 目标：把 Codex 安装修复、交互式模式、输出和 status 重构拆成可以分阶段推进、独立验收的执行清单。
- 使用方式：每个阶段先完成开发项，再补自动化测试，最后通过阶段验收；阶段验收不过，不进入下一阶段。
- 阶段依赖：
  - 阶段 0 是运行时合同基础，必须先于阶段 1、2、4、5 落地。
  - 阶段 3 是 discovery 基础，必须先于阶段 4 和阶段 6 落地。
  - 阶段 5 的 reporter/debug 合同会影响阶段 6 的 JSON、verbose 和 debug 输出边界。
- 统一约束：
  - 所有命令默认在 repo root 执行。
  - `install`、`uninstall`、`upgrade` 的默认 scope 固定为 `user`；`project` 只能显式指定。
  - `status` 的 `--scope` 和 `--platform` 是过滤条件，未传时必须保留“未指定”的语义，不能套用执行型命令默认值。
  - CLI entry、direct command、adapter、discovery、status、路径解析和 catalog 解析必须使用同一份 runtime `env`，不能回落到 `process.env`。
  - 交互式逻辑只存在于 CLI entry/runtime 层，底层 command functions 继续保持脚本化和可测试。
  - `status` 是只读命令，不能为了读取状态而同步、重建或修复 `~/.aw`、账本、tracking manifest 或平台配置。
  - `status --json` 的 `stdout` 必须始终是单一可解析 JSON；人类诊断、debug log 路径和 verbose 输出只能进入 `stderr` 或 debug log。
  - Codex local marketplace 注册固定走 `codex plugin marketplace add <canonical AW_HOME>`，local source 不传 `--ref`、`--sparse`，也不期待 `.tmp/marketplaces/aw` 物化副本。
  - 当前 Codex 上游没有稳定的 `codex plugin install <plugin>@aw` 子命令；本轮只把 marketplace 注册交给 native CLI，插件 enabled 仍由 AW 写 config。

## 阶段总览

| 阶段 | 对应计划 | 目标 | 阶段门禁 |
|------|------|------|------|
| 阶段 0 | Phase 0 | 固定 CLI / command runtime 合同和统一注入走线 | native runner、prompt、reporter、debug logger、env 都从同一 context 贯穿 |
| 阶段 1 | Phase 1 | 统一 options normalization、短选项和 user scope 默认值 | 执行型命令默认 user，status 保留过滤语义，短选项与长选项等价 |
| 阶段 2 | Phase 2 | Codex adapter 接入 native marketplace add | Codex native 安装会通过 fake runner 调用 `codex plugin marketplace add <awHome>` |
| 阶段 3 | Phase 3 | 建立受管和可发现插件 discovery 层 | status、交互式 uninstall/upgrade 可以按 platform + scope 枚举候选 |
| 阶段 4 | Phase 4 | 落地 install / uninstall / upgrade 交互式模式 | TTY 可 prompt，非 TTY/CI 确定性失败，候选选择不退回自由输入 |
| 阶段 5 | Phase 5 | 重构默认输出、verbose 和 debug log | 成功路径说清楚结果，debug 可落盘且脱敏，warning 有序去重 |
| 阶段 6 | Phase 6 | 把 status 重做成日常状态面板 | status 跨 platform/scope 只读扫描，默认摘要、verbose、JSON 各自稳定 |
| 阶段 7 | Phase 7 | 文档收口与最终验收 | 用户文档、架构文档、测试文档和完整回归全部对齐新行为 |

## 阶段 0：CLI / command runtime 合同

### 目标

先把命令运行时能力钉住，让 native runner、交互、输出、debug、env 和 adapter 注入从同一条走线进入所有命令，避免后续阶段各自补入口。

### 开发 TODO

- [ ] 新增 `packages/cli/src/commands/runtime.ts` 或等价模块。
- [ ] 定义 `CommandExecutionContext`，至少包含 `env`、`adaptersFactory` 或 `adapters`、`nativeCliRunner`、`interactive`、`prompt`、`reporter`、`debugLogger` 和 `diagnostics`。
- [ ] 定义 `CliExecutionContext`，包含 `cwd`、`env`、`io`、TTY/CI 交互判定和最终 reporter。
- [ ] 定义 `diagnostics`，统一承接 `verbose`、`debug`、`logFile`、`commandName`、`runId`。
- [ ] 固定 `status` 双层 verbose 语义：`StatusCommandOptions.verbose` 控制状态视图展开，`diagnostics.verbose` 控制 reporter 的命令决策诊断。
- [ ] 让 `install.ts`、`uninstall.ts`、`upgrade.ts`、`status.ts` 停止维护各自字段不一致的本地 `CommandRuntime`。
- [ ] 新增 `createCommandExecutionContext()`，为 direct command 和 CLI entry 补齐默认 runtime。
- [ ] 让 `createAdapters()` 从 context 读取 `nativeCliRunner`、`env` 和 debug hooks。
- [ ] 约束 `prompt` / `interactive` 只由 CLI entry 判定和注入，底层命令不直接读取 `process.stdin.isTTY` 或 `process.env.CI`。
- [ ] 约束 adapter 只执行 native CLI 和记录 debug，不直接渲染用户输出，也不发起 prompt。
- [ ] 约束 discovery、status、默认 adapter 创建、平台检测、home 路径解析和 current catalog 解析都消费 `context.env`。
- [ ] 引入结构化 notices/events 的过渡合同；保留 `warnings: string[]` 时也要能映射到统一 reporter。
- [ ] 保留 prepare / replay warning 的发生顺序，即使最终命令失败，也要先渲染已发生 warning，再渲染 terminal error。
- [ ] 为 prepare 阶段 warning 增加稳定 identity，保证一次 CLI 调用中只渲染一次。
- [ ] 在 `CliRuntimeOptions`、`buildProgram()`、`runCli()` 中只暴露统一 runtime 注入入口。
- [ ] 合并 Commander raw diagnostics、`AW_DEBUG=1` 和测试注入 diagnostics。
- [ ] 固定 `--debug` 和 `AW_DEBUG=1` 都隐含 `verbose=true`。
- [ ] 固定 `--log-file <path>` 只决定 debug log 路径，不单独开启 verbose。
- [ ] 固定 debug log 默认落点：写命令默认 `~/.aw/logs/aw-<timestamp>-<command>.log`，`status` 默认系统临时目录。
- [ ] CLI action 调用各 command 时透传同一个 context，不在 action 内临时拼命令专用对象。

### 自动化测试

- [ ] CLI entry 注入 fake native runner 后，`install/upgrade` 和 Codex adapter 使用同一条 runner 走线。
- [ ] `status` 通过同一 context 接收 fake adapters/debug logger，但默认读取路径不调用 native runner。
- [ ] CLI entry 注入 fake prompt 后，交互式 `install/uninstall/upgrade` 不访问真实 stdin。
- [ ] `--verbose` / `--debug` 能把 command events 和 native invocation events 送到 reporter/debug logger。
- [ ] `AW_DEBUG=1` 与 `--debug` 进入同一条 debug logger 走线，且都隐含 verbose。
- [ ] `--log-file` 指定的路径被 debug logger 使用。
- [ ] `aw status -j`、`aw status -j --verbose`、`aw status -j --debug`、`aw status -j --verbose --debug` 的 `stdout` 都保持纯 JSON。
- [ ] `statusCommand(..., { env })` 不注入 adapter 时，平台检测、默认 adapter 创建、ledger、catalog 和 home 路径都来自 runtime env。
- [ ] `runCli(..., { env })` 走完整 CLI entry 时，fake runner、context、discovery、status 和默认 adapter 都不回落到 `process.env`。
- [ ] direct command 不传 runtime 时仍走生产默认值；传 partial runtime 时缺省字段由统一 context builder 补齐。

### 阶段验收

- [ ] CLI / command 运行时能力只通过统一 `CommandExecutionContext` 透传。
- [ ] native runner、prompt、reporter、debug logger、diagnostics 和 env 在 CLI entry 与 direct command 中行为一致。
- [ ] `status --json` 的 stdout 边界被测试锁住，不会被 verbose/debug 诊断污染。
- [ ] prepare / replay warning 能有序、去重地先于最终错误输出。

## 阶段 1：options normalization、短选项与 user scope 默认值

### 目标

把执行型命令和 status 的 options 语义拆开。执行型命令默认 `user/auto`，status 保留过滤语义；同时固定常用短选项，避免后续阶段各自发明入口。

### 开发 TODO

- [ ] 新增 `packages/cli/src/commands/options.ts` 或等价模块。
- [ ] 实现 `normalizeCommandOptions(raw, { cwd, defaultScope: 'user', defaultPlatform: 'auto' })`，只服务 `install/uninstall/upgrade`。
- [ ] 实现 `normalizeInstallCommandOptions(...)`。
- [ ] 实现 `normalizeUpgradeCommandOptions(...)`。
- [ ] 实现 `normalizeStatusCommandOptions(raw, { cwd })`，返回独立 `StatusCommandOptions`。
- [ ] 在 status 中把 `raw.platform === 'auto'` 归一为未指定平台过滤。
- [ ] 对 `scope`、`platform`、`skillTrigger` 做统一校验，错误信息与 Commander 层一致。
- [ ] 固定短选项：`-s/--scope`、`-p/--platform`、`-t/--skill-trigger`、`-i/--interactive`、`-a/--all`、`-v/--verbose`、`-D/--debug`、`-j/--json`、`-f/--force`。
- [ ] 保持 `--no-interactive` 和 `--log-file <path>` 为长选项。
- [ ] `init` 增加 `.option('-f, --force', ...)`。
- [ ] `install/uninstall` 的 Commander 参数从 `<plugins...>` 改成 `[plugins...]`。
- [ ] 缺插件名校验迁到 CLI runtime 决策之后，TTY 且允许交互时进入选择，非 TTY/CI/`--no-interactive` 时返回业务错误和示例。
- [ ] `install/uninstall/upgrade` 的 Commander 默认 scope 改成 `user`。
- [ ] `status` 的 `--scope` / `--platform` 不在 Commander 层设置默认值。
- [ ] `upgrade --all` 同时收到 `--skill-trigger` 或 `-t` 时，在入口层返回确定性错误。
- [ ] `toCommandOptions()` 默认改为 `user`，并只用于执行型命令。
- [ ] 新增 `toStatusCommandOptions()`，不要复用执行型 normalizer。
- [ ] 新增 `toCliDiagnosticsOptions()` 或等价 helper，把 `verbose/debug/logFile/AW_DEBUG` 合并后传给 runtime。
- [ ] 在 command function 入口也调用 normalization，避免绕过 CLI entry 时 partial options 直接崩溃。
- [ ] 更新 `README.md`、`docs/plugin-installation.md`、`docs/architecture.md` 中涉及默认 scope 的描述。

### 自动化测试

- [ ] `installCommand(['git-commit'], { cwd } as any, ...)` 不再抛 undefined 访问，按 user/auto 默认值执行或返回业务错误。
- [ ] `uninstallCommand(['git-commit'], { cwd } as any, ...)` 不再抛 undefined 访问，按 user/auto 默认值执行或返回业务错误。
- [ ] `upgradeCommand(['git-commit'], { cwd } as any, ...)` 不再抛 undefined 访问，按 user/auto 默认值执行或返回业务错误。
- [ ] `upgradeCommand([], { cwd, all: true } as any, ...)` 覆盖 `--all` partial options 路径。
- [ ] `statusCommand([], { cwd } as any, ...)` 不再抛 undefined 访问，并按未指定 scope/platform filter 进入 status 聚合。
- [ ] 非法 `scope/platform/skillTrigger` 返回明确 `Unsupported ...`。
- [ ] `aw init -f`、`aw install git-commit -p codex -s user -t manual`、`aw upgrade -a -p both`、`aw status -j` 与长选项等价。
- [ ] `aw status -j` 不隐式带上 `scope=user`。
- [ ] `install/uninstall/upgrade/status` 的 `-v`、`-D`、`--log-file` 都进入统一 diagnostics。
- [ ] `AW_DEBUG=1 aw status git-commit` 与 `aw status git-commit --debug` 产生等价 diagnostics。
- [ ] `runCli(['install'])` / `runCli(['uninstall'])` 缺插件名时穿过 Commander 参数层，本阶段覆盖非交互业务错误路径。
- [ ] `runCli(['install', ..., '--skill-trigger', 'manual|auto|default'])` 继续影响最终 materialization。
- [ ] 显式插件 `upgrade --skill-trigger manual|auto|default` 继续透传。
- [ ] `upgrade --all --skill-trigger manual` 和 `upgrade -a -t manual` 在入口层确定性拒绝。

### 阶段验收

- [ ] 执行型命令默认 scope 已统一为 `user`。
- [ ] status 未传 `--scope/--platform` 时仍能保留跨 scope/platform 扫描所需信息。
- [ ] 常用短选项与长选项行为等价，且测试覆盖。
- [ ] partial options 不再导致 `Cannot read properties of undefined (...)`。

## 阶段 2：Codex adapter 接入 native marketplace 命令

### 目标

让 Codex native 插件安装先通过 Codex 原生命令注册 local marketplace，避免只靠 AW 直接写 config 导致“配置看起来存在，运行时找不到插件”。

### 开发 TODO

- [ ] 扩展 `CodexAdapter` 构造函数为 `constructor(cwd: string, nativeCliRunner?: NativeCliRunner, env = process.env)` 或等价形态。
- [ ] 让 `createAdapters(cwd, env, { nativeCliRunner? })` 从阶段 0 的 context 获取 runner。
- [ ] 保持 Claude/Codex adapter 共用同一套 native runner 注入模型。
- [ ] CLI entry integration 通过 runtime 注入 fake runner 或 fake adapters，不依赖真实 `codex` 二进制。
- [ ] 新增 `buildCodexMarketplaceAddInvocation(awHome, cwd, env)`。
- [ ] 固定 invocation 为 `codex plugin marketplace add <canonical AW_HOME>`。
- [ ] 确认 local AW_HOME source 不带 `--ref`、`--sparse` 或其它未确认 flag。
- [ ] 修改 `CodexAdapter.installPlugin()`：`requiresNativePlugin(plugin) === false` 时不写 native state。
- [ ] 需要 native state 时先 `ensureLocalMarketplace()`，再取 `resolveAwHomeCanonical()`。
- [ ] 当 `[marketplaces.aw]` 缺失、source/source_type 不匹配，或 source 指向旧 manifest 文件时，调用 `runNativeCli(...)`。
- [ ] native add 之后重新读取 `~/.codex/config.toml`，校验 marketplace 指向 canonical AW_HOME。
- [ ] native add 校验失败时抛出面向用户的动作型错误，覆盖 stderr/stdout 摘要、空输出、timeout 和 `ENOENT`。
- [ ] 保留 `upsertCodexPluginEnabledFile()` 作为插件启用步骤，不引入不存在的 native install 分支。
- [ ] 保持 rollback/degraded 语义：native command 成功后 artifact/tracking 失败仍标记 `operation_interrupted_after_native_write`。
- [ ] 失败回滚不盲目删除 `[marketplaces.aw]`，删除仍走现有 shared refs 全账本扫描策略。

### 自动化测试

- [ ] Codex native 插件安装会调用 fake runner：`codex plugin marketplace add <awHome>`。
- [ ] fake runner 断言 args 精确为 `['plugin', 'marketplace', 'add', awHome]`。
- [ ] invocation 传入 canonical marketplace 根目录，不是 `.agents/plugins/marketplace.json`。
- [ ] marketplace 已正确注册时不重复调用 native add。
- [ ] source 指向旧 manifest 文件或错误目录时会调用 native add 修复。
- [ ] native add 失败时错误包含用户可理解的动作和原始 stderr 摘要。
- [ ] local source 注册成功后不要求 `.tmp/marketplaces/aw` 存在。
- [ ] instruction-only Codex 插件不调用 native add。
- [ ] `runCli(['install', 'git-commit', '--platform', 'codex'])` 通过 CLI runtime fake runner 完成 native add。
- [ ] fake runner 返回失败时 CLI 退出码为 1，并渲染 native add 失败信息和 stderr 摘要。
- [ ] 无 stdout/stderr、timeout、`ENOENT`、PATH 异常都有可读错误和下一步建议。
- [ ] `--debug` 日志保留 exit code、stdout/stderr 摘要、invocation command/args/cwd 和 cause 类型。
- [ ] 保留或更新 `AW_FORCE_CODEX_AVAILABLE=1` + `PATH=''` 的 CLI entry 用例，避免误触真实二进制。

### 阶段验收

- [ ] Codex native 插件安装不再只靠直接写 config 注册 marketplace。
- [ ] fake runner 可以完整覆盖 native add 行为，不要求测试环境安装真实 `codex`。
- [ ] `[marketplaces.aw]` 最终满足 `source_type = "local"` 且 `source = "<canonical ~/.aw>"`。
- [ ] Codex local source 注册不依赖 `.tmp/marketplaces/aw` 副本存在。

## 阶段 3：受管和可发现插件 discovery 层

### 目标

建立 status 和交互式 `uninstall/upgrade` 共同使用的候选枚举能力，避免继续把 current catalog loader 当成通用入口。

### 开发 TODO

- [ ] 新增 `packages/cli/src/commands/discovery.ts` 或等价模块。
- [ ] 实现 `discoverManagedPluginNames({ cwd, scopeFilter, platformFilter, env })`。
- [ ] 实现 `resolveDiscoveredPluginTargets({ cwd, scopeFilter, names, env })`。
- [ ] 实现 `buildCommandCandidates({ command: 'status' | 'uninstall' | 'upgrade', ... })`。
- [ ] discovery 入口按平台派生 project identity：Codex project scope 锚定 repo root realpath，Claude project scope 锚定调用目录 realpath。
- [ ] 从 AW ledger、tracking manifest、Codex native config、Claude native/runtime evidence 和 current catalog 合并插件名。
- [ ] 枚举阶段只收集名字和证据摘要，不丢掉 current catalog 已删除的插件。
- [ ] 目标解析阶段优先解析 current catalog target，找不到时生成 historical placeholder。
- [ ] current catalog 解析使用 runtime env；`~/.aw` 缺失、stale 或不健康时只读回退 embedded catalog，并保留诊断原因。
- [ ] historical target 按 `(pluginName, platform, scope)` 建模，不生成跨 scope/platform 的 union manifest。
- [ ] `createHistoricalPluginMeta()` 或替代 helper 接收 platform、scope 和该格子的 evidence。
- [ ] Codex historical placeholder 恢复 repo-managed artifact kind 时以 tracking manifest 为主要真值。
- [ ] 只有 ledger coarse boolean 时返回 `unknown`、禁用态或等价保守结论，不能合成具体 hook/instruction/permission/agent 能力。
- [ ] `status` orchestrator 对矩阵逐格调用 `adapter.status(target.plugin, scope)`。
- [ ] discovery 输出携带 `selectable`、`disabledReason`、`evidenceByPlatformScope`。
- [ ] `loadPluginTargetsForCommand()` 保留给 install 和显式插件名解析，不再作为无参数 status 或交互式卸载/升级默认枚举入口。
- [ ] discovery helper 只返回候选和证据，不直接执行 install/uninstall/upgrade。

### 自动化测试

- [ ] current catalog 已删除但 ledger 仍有记录时，`uninstall` 和 `status` 候选仍能列出该插件。
- [ ] 只有 tracking manifest 证据时，候选仍出现并标注证据来源。
- [ ] 只有 Codex native `plugin@aw` 或 shared native refs 证据时，status 能列出。
- [ ] current catalog 已删除且插件只存在于 project scope 时，默认 `aw status <plugin>` 不误报成 user scope。
- [ ] 同名插件在 user/project 都有证据时，默认 status 分别输出两格状态，不合成一份 placeholder。
- [ ] repo 子目录运行 discovery 时，Codex project tracking、ledger、native evidence 与 repo root 运行一致。
- [ ] repo 子目录运行 discovery 时，Claude project scope 使用子目录 realpath，不混入 repo root 或兄弟目录证据。
- [ ] 交互式 `uninstall/upgrade` 候选从 repo 子目录运行时，Codex project candidate 指向 repo root。
- [ ] ledger-only 只有 `hasRepoManagedArtifacts: true` 的 Codex 历史插件不会恢复成 hook-capable 或其它具体能力。
- [ ] tracking 明确记录 `kind: "hook"` 或 hook identity 时，才能恢复 hook 能力。
- [ ] catalog/current/historical 名字去重后顺序稳定。
- [ ] 某个平台或 scope 读取失败时，只把对应证据标成 `unknown`，不让整个列表失败。

### 阶段验收

- [ ] discovery 能从 ledger、tracking、native config/runtime evidence 和 current catalog 合并候选。
- [ ] 候选身份保留 `platform + scope + projectKey/executionCwd`，不会按插件名模糊合并。
- [ ] historical placeholder 保守且分格，不会凭粗粒度 ledger 恢复具体能力。
- [ ] status 和交互式候选构建可复用 discovery，不再依赖 current catalog loader 枚举已安装目标。

## 阶段 4：交互式模式

### 目标

让 `install`、`uninstall`、`upgrade` 在 TTY 下可以通过候选列表完成选择，同时保持非 TTY、CI 和 `--no-interactive` 的脚本友好确定性。

### 开发 TODO

- [ ] 新增轻量交互层，首版优先使用 Node `readline/promises`。
- [ ] 新增 `CliPrompt` 抽象，测试可注入 fake prompt。
- [ ] 实现 `selectPlatform({ available, defaultValue })`。
- [ ] 实现 `selectScope({ defaultValue: 'user' })`。
- [ ] 实现 `selectPlugins({ command, candidates, defaultValues, allowMultiple })`。
- [ ] 实现 `selectUpgradeMode({ canUpgradeAll, candidates })`。
- [ ] 实现 `selectSkillTrigger({ defaultValue: 'default', allowSkip: true })`。
- [ ] 固定 `CommandCandidate` 身份模型，至少包含 `id`、`pluginName`、`platform`、`scope`、`projectKey?`、`executionCwd`、`selectable`、`disabledReason?` 和 evidence summary。
- [ ] `install` candidate 携带兼容平台和目标格子的可安装性。
- [ ] 固定规则：`scope=project` 且 `platform=codex` 时，只有 `hasRepoManagedArtifacts(plugin) === true` 的插件可安装。
- [ ] prompt 返回 candidate selection 后，runtime 校验 token 必须来自本轮候选列表。
- [ ] dispatch 前按 `platform + scope + executionCwd` 分组选中 candidate，再调用普通 command API。
- [ ] `install` 采用“先锁定 scope/platform，再展示候选”的路径。
- [ ] 显式插件名交互式 `install` 先计算整组插件的 compatiblePlatforms 交集。
- [ ] 显式多插件名不自动拆分命令，无共同兼容平台时在 dispatch 前返回业务错误。
- [ ] 无插件名交互式 `install` 在平台锁定后过滤 catalog 候选，`both` 只允许同时支持 Codex 和 Claude 的插件。
- [ ] `Codex + project scope` 下过滤或禁用纯 native-only 插件，显式插件名路径也要在 dispatch 前早失败。
- [ ] `uninstall` 候选来自阶段 3 discovery。
- [ ] `upgrade` 候选来自阶段 3 discovery 与 current catalog 兼容性判断。
- [ ] 交互式“全部可升级”复用 `upgrade --all` preflight，不做隐式 safe-subset。
- [ ] mixed safe/blocked 候选下，显式勾选安全子集按普通插件列表执行，`all: false`。
- [ ] degraded ledger 下需要显式 `skill-trigger` 的重复 install 和显式 upgrade，在 dispatch 前补问。
- [ ] 非 TTY、CI、`--no-interactive` 或没有 prompt 时，不补问，继续返回确定性错误。
- [ ] fake prompt 返回 skip、空值、非法 skill-trigger、非法 candidate id 或过期 token 时在 runtime 层拒绝。
- [ ] 文案使用默认选项优先、列表选择和可读禁用原因，不提示用户手动输入插件名。

### 自动化测试

- [ ] `runCli(['install'], { prompt: fakePrompt })` 能通过 catalog 候选选择插件。
- [ ] `runCli(['uninstall'], { prompt: fakePrompt })` 能通过已安装候选选择插件。
- [ ] `runCli(['upgrade'], { prompt: fakePrompt })` 能选择具体插件或“全部可升级”。
- [ ] `install/uninstall` 缺插件名不会被 Commander `<plugins...>` 拦截。
- [ ] repo 子目录下交互式 `uninstall/upgrade` 能看到 repo root 的 Codex project scope 安装。
- [ ] repo 子目录下 Claude project 候选只使用子目录 projectKey。
- [ ] mixed safe/blocked 候选下，非交互 `upgrade --all` 和交互式“全部可升级”都 fail-fast 且不写入。
- [ ] mixed safe/blocked 候选下，显式勾选安全子集以普通插件列表执行。
- [ ] 交互式插件 prompt 不调用自由文本输入，fake prompt 返回候选外插件名会被拒绝。
- [ ] historical plugin 可出现在交互式 `uninstall` 候选里。
- [ ] catalog missing 的历史插件在 `upgrade` 中显示为禁用项和建议。
- [ ] 同名插件跨 platform/scope 共存时，可以只选择其中一格，最终只处理该格。
- [ ] fake prompt 返回合法插件名但错误 candidate id、platform/scope 或过期 token 时会被拒绝。
- [ ] 双平台 `auto` 歧义时，TTY prompt 选择平台后继续安装。
- [ ] 单平台插件不会被选择到不兼容平台或 `both`。
- [ ] 显式多插件名无共同兼容平台时 runtime 早失败。
- [ ] `Codex + project scope` 下纯 native-only 插件不可作为可安装候选。
- [ ] degraded ledger 下重复 install / 显式 upgrade 会补问 skill-trigger 并透传 `requestedSkillTrigger`。
- [ ] degraded ledger 下非交互、CI、`--no-interactive` 继续返回确定性错误。
- [ ] `--interactive`、`--no-interactive`、`CI=true` 的优先级被测试锁住。

### 阶段验收

- [ ] TTY 下 `aw install`、`aw uninstall`、`aw upgrade` 可以通过候选列表完成缺失参数选择。
- [ ] 非 TTY、CI 和 `--no-interactive` 不会挂起，错误信息来自 CLI 业务层。
- [ ] 所有交互式选择都保留 candidate 身份，不会退化成按插件名模糊执行。
- [ ] 交互式 `install` 在 prompt 层同时约束平台兼容性和 scope + platform 可安装性。

## 阶段 5：输出、日志与 debug 系统

### 目标

让默认成功路径对普通用户说清楚做了什么，让 verbose 解释关键决策，让 debug log 给维护者留下完整、脱敏、可复现的事件链。

### 开发 TODO

- [ ] 新增统一输出模型，包含 `CommandNotice`、`CommandEvent`、`OutputLevel`、`OutputTarget` 和结构化来源字段。
- [ ] 新增 `packages/cli/src/output/reporter.ts`，负责 stdout/stderr 渲染、去重、排序和 TTY/非 TTY 差异。
- [ ] 新增 `packages/cli/src/output/debug-log.ts`，负责 debug 文件创建、脱敏、轮转和日志路径提示。
- [ ] 新增 `packages/cli/src/output/redact.ts`，统一隐藏 token、password、secret、key、authorization、cookie 等敏感字段。
- [ ] `-v/--verbose` 输出关键决策到 stderr，不落完整日志。
- [ ] `-D/--debug` 开启完整 debug log，并隐含 verbose。
- [ ] `AW_DEBUG=1` 等价于 `--debug`。
- [ ] `--log-file <path>` 控制 debug log 路径。
- [ ] 写命令默认 debug log 写到 `~/.aw/logs` 并做保留策略。
- [ ] `status` 默认 debug log 写到系统临时目录，不创建或清理 `~/.aw/logs`。
- [ ] 默认输出覆盖 install/uninstall/upgrade 正常路径：目标、catalog、marketplace、native、plugin、repo artifacts、完成摘要和下一步。
- [ ] verbose 输出记录 normalized options、platform resolution、catalog resolution、marketplace repair decision、skill trigger decision 和被降噪的 drift 诊断。
- [ ] debug log 记录 runId、时间戳、CLI/Node 版本、平台、argv、cwd、AW_HOME、配置路径、步骤耗时、native invocation、文件写入计划、rollback/degraded 和最终 notices/error。
- [ ] 文件写入 debug 只记录路径和摘要，不记录完整敏感内容。
- [ ] 调整命令结果，从散落的 `output` / `warnings` 过渡到结构化 notices。
- [ ] 默认不再把所有后置 `driftWarnings` 直接作为命令 warning 输出。
- [ ] 只保留会影响本次可用性的用户可处理事项，并改写成自然语言。
- [ ] 改造 `writeWarnings()`，中文默认使用 `注意：` 或 `需要处理：`，不再硬编码英文 `Warning:`。
- [ ] 对 `[codex/git-commit]` 这类内部前缀改成结构化来源或用户可读句子。
- [ ] degraded / skill trigger 文案专门翻译为可操作提示。
- [ ] prepare / replay warning 保持发生顺序并在一次 CLI 调用内去重。

### 自动化测试

- [ ] 成功安装不出现英文 `Warning:`。
- [ ] 成功安装包含 catalog、marketplace/native、plugin enabled 和完成摘要。
- [ ] 成功卸载、升级包含目标插件、platform、scope 和下一步摘要。
- [ ] degraded warning 被渲染成用户能理解的中文。
- [ ] `--verbose` 输出 normalized options、platform/catalog 选择和被降噪的 drift 诊断。
- [ ] `--debug` 生成 debug log，失败时 stderr 提示日志路径。
- [ ] `status --json --debug` 不污染 JSON stdout，日志路径只进 stderr 或 debug log。
- [ ] `aw status --debug` 未传 `--log-file` 时不创建 `~/.aw` 或 `~/.aw/logs`。
- [ ] 显式 `--log-file <path>` 只写用户指定文件。
- [ ] debug log 会脱敏 `TOKEN`、`PASSWORD`、`SECRET`、`AUTHORIZATION` 等字段和命令输出。
- [ ] 非 TTY 输出稳定，无 spinner 控制字符。
- [ ] degraded replay warning 先于 `upgrade --all` 阻断错误输出。
- [ ] degraded replay warning 先于显式插件 `upgrade` 的 skill-trigger 继承失败错误输出。
- [ ] `init` / `install` entry flow 中同一条 prepare warning 一次命令只出现一次。

### 阶段验收

- [ ] 默认成功路径不再沉默，也不暴露内部诊断格式。
- [ ] verbose 能解释“为什么这样做”，debug log 能复盘完整事件链。
- [ ] debug log 默认脱敏，轮转或清理失败不影响主命令。
- [ ] warning 输出中文可读、有序、去重，并与 terminal error 的相对顺序稳定。

## 阶段 6：status 日常状态面板

### 目标

把 `aw status` 从底层诊断输出改成日常状态面板，回答“现在真实状态是什么、哪里需要处理、下一步做什么”，并保持完全只读。

### 开发 TODO

- [ ] 引入独立 `StatusCommandOptions`，包含 `cwd`、`scope?: Scope`、`platform?: 'codex' | 'claude' | 'both'`、`verbose?: boolean`、`json?: boolean`。
- [ ] `statusCommand()` 不再用执行型命令的 `resolveTargetPlatforms()` 处理默认路径。
- [ ] 未传 `--platform` 时扫描可用平台和有证据的平台。
- [ ] 未传 `--scope` 时扫描 user/project 两个 scope。
- [ ] adapter 层 `PlatformAdapter.status(plugin, scope)` 保持单 platform + scope 形状，由 status orchestrator 聚合矩阵。
- [ ] 新增 `StatusSummary` / `StatusMatrixReport` 或等价聚合模型。
- [ ] status、status orchestrator 和 discovery 默认路径不得调用 `ensureLocalMarketplace()` 或任何 repair/sync 写入。
- [ ] 本地 marketplace 缺失、stale 或不健康时，status 只读回退 embedded catalog 并记录原因。
- [ ] `status --debug` 未传 `--log-file` 时不创建或清理 `~/.aw/logs`。
- [ ] `aw status` 无参数时通过 discovery 列出 AW 管理过或平台可发现的插件摘要。
- [ ] `aw status <plugin>` 默认扫描相关 platform/scope 证据，不因 `auto` 双平台歧义报错。
- [ ] 显式 unknown plugin 在无证据时输出未安装和安装建议，不再抛 `Unknown plugin`。
- [ ] 默认输出采用“摘要 + 明细 + 下一步”：health、platform/scope 状态点和最可能命令。
- [ ] 默认输出不出现 raw `catalogCompatibility=`、`scopeInitialized=`、`driftWarnings=` 等字段名。
- [ ] status 展示平台可加载性、AW 管理状态、scope 有效性、本地 marketplace 健康和 skill trigger 偏好一致性。
- [ ] 保留 skill-trigger 状态矩阵，不把 `matched`、`matches(default,auto)`、`mixed`、`drift`、`unknown`、historical fallback 压平。
- [ ] 定义 health model：`ready`、`partial`、`needsAttention`、`external`、`notInstalled`、`unknown`。
- [ ] Codex native marketplace 状态在 verbose/json 中保留 `marketplaceRegistered`、`marketplaceSource`、`marketplaceSourceType`、`marketplaceRootResolution`。
- [ ] 默认摘要把 Codex local marketplace 表达为自然语言，不要求 `.tmp/marketplaces/aw` 存在。
- [ ] 支持默认人类摘要、`--verbose` 展开、`--json` 稳定 schema、`--debug` 读取链路日志。
- [ ] `--json` 与 `--verbose/--debug` 可叠加，但 stdout 始终是单一 JSON payload。
- [ ] 常见异常给出可复制建议：manifest source 错误、ledger degraded、catalog missing、capability changed。

### 自动化测试

- [ ] `aw status` 无参数能列出受管插件摘要。
- [ ] `aw status git-commit` 不传 `--platform/--scope` 时能展示 Codex user 和 project 证据。
- [ ] repo 子目录运行 `aw status` 时仍能列出 repo root 的 Codex project scope 受管插件摘要。
- [ ] repo 子目录运行时，Claude project scope 只读取该子目录 `.claude/` 与对应 project key。
- [ ] 无安装证据时输出未安装和安装建议，不空白、不报平台歧义。
- [ ] `aw status <unknown-plugin>` 无任何证据时默认输出未安装，JSON 输出 `health=notInstalled` 或等价字段。
- [ ] 执行型命令仍对 unknown plugin 报 `Unknown plugin`。
- [ ] current catalog 已删除但 ledger/tracking/native 仍有证据时，默认 status 仍列出历史插件并标注目录缺失。
- [ ] 单个平台不可用、单个 scope 读取失败或某侧 unknown 时，整体 health 不误判为 `notInstalled`。
- [ ] `--scope user/project` 只过滤明细矩阵，不改变未传 scope 的跨 scope 默认扫描。
- [ ] 默认输出不出现 raw 内部字段名。
- [ ] `--verbose` 展开完整诊断字段。
- [ ] `--json` 输出稳定 schema，覆盖所有 health 状态。
- [ ] `aw status -j`、`-j --verbose`、`-j --debug`、`-j --verbose --debug` 的 stdout 都是纯 JSON。
- [ ] skill-trigger 状态矩阵继续覆盖 matched、equivalent defaults、mixed、drift、unknown、historical fallback。
- [ ] stale marketplace、布局损坏、degraded ledger、runtime skill 文件异常时，verbose/json 诊断不丢。
- [ ] 常见异常输出一条可复制修复命令。
- [ ] `~/.aw` 缺失、marketplace 损坏或 ledger degraded 时，status 输出诊断但不创建/修改 `~/.aw`。
- [ ] stale `~/.aw/config.json` 下，status 回退 embedded catalog，且不创建插件目录、不改写 config、不触发 repair。
- [ ] `--verbose` / `--json` 能看出 `source=embedded` 和本地 marketplace 不健康原因。
- [ ] status 不改写 `installed.json`、tracking manifest 或平台配置；用文件存在性、mtime 或内容快照锁住。

### 阶段验收

- [ ] `aw status` 不传完整 platform/scope 也能展示有价值的真实状态和下一步建议。
- [ ] status 默认、verbose、json、debug 四种出口边界清晰且测试稳定。
- [ ] status 完全只读，不会初始化、同步、修复或清理业务状态。
- [ ] unknown plugin 在 status 中是 `notInstalled` 状态，在执行型命令中仍是明确错误。

## 阶段 7：文档与最终验收

### 目标

把用户文档、架构文档、测试规范和最终回归全部收口到新行为，确保发布前说明、实现和测试一致。

### 开发 TODO

- [ ] 更新 `README.md` 快速使用，推荐 `aw install git-commit` 和 `aw install` 交互式。
- [ ] 在 README 中展示短选项示例，例如 `aw install git-commit -p codex -s user`。
- [ ] README 示例默认不再写 `--scope project`。
- [ ] 更新 `docs/plugin-installation.md`，说明 install/uninstall/upgrade 默认 scope 是 user。
- [ ] 说明 `status --scope` 是过滤条件，未传时会跨 scope 扫描。
- [ ] 新增短选项对照表。
- [ ] 新增 install/uninstall/upgrade 交互式模式说明，强调插件名来自列表选择。
- [ ] 更新 Codex native marketplace 说明：通过 `codex plugin marketplace add ~/.aw` 校验并注册 local source。
- [ ] 说明 Codex local source 不会被复制成 `.tmp/marketplaces/aw` 副本。
- [ ] 保留 Codex `project` scope 只影响 repo-managed artifacts 的说明。
- [ ] 更新 `docs/architecture.md`，补充 Codex adapter native CLI 边界、reporter/notices/debug log 分层。
- [ ] 更新 `docs/testing.md`，补充 fake prompt、fake native runner、repo 子目录、historical placeholder、status JSON、runtime env、stale marketplace、reporter/debug log 和 `--skill-trigger` 回归约定。

### 自动化测试

- [ ] 运行 `pnpm test:unit`。
- [ ] 运行 `pnpm test:integration`。
- [ ] 至少运行一次 `pnpm test:smoke:build`。
- [ ] 检查 CLI 入口测试覆盖短选项与长选项等价。
- [ ] 检查交互式测试不访问真实 stdin。
- [ ] 检查 native runner 测试不依赖真实 Codex / Claude CLI。
- [ ] 检查 status JSON 测试用 `JSON.parse` 验证 stdout 纯度。
- [ ] 检查只读 status 测试覆盖 `~/.aw` 缺失、stale 和 degraded 场景。

### 阶段验收

- [ ] README、安装文档、架构文档和测试文档都与新默认行为一致。
- [ ] 文档中的命令示例优先使用 user scope 和短选项，不再误导用户走 project 默认。
- [ ] 所有阶段的关键行为都有单元或集成测试覆盖。
- [ ] `pnpm test:unit`、`pnpm test:integration`、`pnpm test:smoke:build` 通过。

## 总体验收清单

- [ ] `aw install git-commit --platform codex` 未传 `--scope` 时安装到 user scope。
- [ ] 常用短选项 `-s`、`-p`、`-t`、`-i`、`-a`、`-v`、`-D`、`-j`、`-f` 可用且与长选项等价。
- [ ] `--skill-trigger` 只作用于显式 `install` 和显式插件 `upgrade`；`upgrade --all --skill-trigger` 与 `upgrade -a -t` 确定性拒绝。
- [ ] Codex native 插件安装会调用 `codex plugin marketplace add <canonical AW_HOME>`。
- [ ] `runCli()` / `buildProgram()` 可以注入 fake native runner、fake adapters 和 fake prompt。
- [ ] `CommandExecutionContext.env` 贯穿所有读取路径，测试注入 env 后不回落到 `process.env`。
- [ ] 不完整 options 不再产生 undefined 访问错误。
- [ ] TTY 下 `aw install`、`aw uninstall`、`aw upgrade` 可以通过交互完成选择；非 TTY/CI 不会阻塞。
- [ ] 交互式插件选择来自候选列表，不接受任意字符串。
- [ ] `Codex + project scope` 只允许安装包含 repo-managed artifacts 的插件。
- [ ] current catalog 已删除但仍有管理证据的插件，能出现在 status 和交互式 uninstall 候选里。
- [ ] historical placeholder 按 platform + scope 分格，不合成模糊能力。
- [ ] `upgrade --all` 保持 fail-fast 合同。
- [ ] 默认成功路径不输出 `Warning: [codex/git-commit] ...` 这类内部诊断格式。
- [ ] 默认成功路径说明 catalog、marketplace/native 注册、插件启用和下一步。
- [ ] `--verbose` 展示关键决策，`--debug` 或 `AW_DEBUG=1` 生成脱敏 debug log。
- [ ] `aw status --debug` 默认日志在系统临时目录，不创建或清理 `~/.aw/logs`。
- [ ] `aw status` 跨 platform/scope 展示状态，`--scope` / `--platform` 只过滤结果。
- [ ] `aw status <unknown-plugin>` 无证据时输出未安装，`aw install <unknown-plugin>` 仍报 `Unknown plugin`。
- [ ] `aw status -j`、`aw status -j --verbose`、`aw status -j --debug`、`aw status -j --verbose --debug` 的 stdout 都是纯 JSON。
- [ ] status 继续覆盖 skill-trigger 状态矩阵，默认、verbose、json 都有明确落位。
- [ ] status、discovery 和交互式候选在 repo 子目录运行时，Codex project scope 锚定 repo root，Claude project scope 锚定调用目录 realpath。
- [ ] status 完全只读，不同步、不重建、不修复业务状态。
- [ ] stale `~/.aw` 下 status 回退 embedded catalog，并在 verbose/json 中说明本地 marketplace 不健康原因。
- [ ] Codex native add 失败提示覆盖 stderr、空输出、timeout、`ENOENT` 和 PATH 异常。
