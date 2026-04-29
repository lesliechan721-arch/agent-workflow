# Codex 安装修复、交互式模式与用户提示改进计划

## 背景

当前 `packages/cli` 的安装体验在 Codex 侧暴露了几类相互关联的问题：

- Codex native marketplace 只靠 CLI 直接写 `~/.codex/config.toml`，没有走 `codex plugin marketplace add <dir>`，也就绕过了上游对 marketplace root 的校验和 local source 注册流程，容易出现“配置看起来存在，运行时却找不到插件”的状态。
- 命令入口只在 Commander 层补默认值，命令函数本身假设 `scope/platform/cwd` 都已完整传入；一旦从测试、脚本或其它内部入口传入不完整 options，就可能走到难懂的 undefined 访问错误，例如 `Cannot read properties of undefined (reading 'aw')`。
- 安装/卸载成功后的用户提示过于偏诊断日志，默认输出会直接透出 `installed.json degraded`、`repo trust unknown`、`skill trigger re-election` 这类内部术语。
- 反过来，正常成功路径又太安静：用户很难看出 CLI 解析了哪个 catalog、选择了哪个 platform/scope、有没有同步 `~/.aw`、有没有调用原生命令、最后下一步该做什么。
- 缺少统一 debug 出口。现在排查问题主要靠临时加输出或看 `aw status`，没有一次命令的完整决策链、原生命令 stdout/stderr、耗时、路径和脱敏后的环境上下文。
- 没有交互式模式；用户在安装、卸载、升级时遇到双平台、缺插件名、缺平台选择等场景，必须记住完整参数。
- 常用命令选项只有长名称，脚本和日常手输都偏啰嗦；后续新增交互、日志、status 输出模式时也需要先固定短选项命名，避免各阶段各自发明。
- 当前 `--scope` 默认值仍是 `project`，和希望把 user 级安装作为默认体验的目标不一致。

本文目标是先给出可落地执行计划，不直接改业务代码。

## 当前实现探索

### CLI 入口与默认值

- `packages/cli/src/index.ts`
  - `toCommandOptions()` 当前把 `rawOptions.scope ?? 'project'` 和 `rawOptions.platform ?? 'auto'` 转成强类型 `CommandOptions`。
  - `install/uninstall/upgrade/status` 的 Commander option 也都把 `--scope` 默认写成 `project`。
  - `install` 仍用 `.argument('<plugins...>')`，缺插件名会在 Commander 层直接失败，无法进入交互式流程。
  - `uninstall` 也用 `.argument('<plugins...>')`，缺插件名同样无法进入交互式流程；`upgrade` 虽是 `[plugins...]`，但没有交互式选择插件或 `--all` 的入口。
  - `--scope`、`--platform`、`--skill-trigger`、`--all` 等常用选项目前没有短名。
  - `writeWarnings()` 固定输出 `Warning: ${warning}`，命令层无法区分“需要用户处理的问题”和“只适合 status 诊断的信息”。
  - `runCli()` 只注入 `stdout/stderr` 写函数，没有统一 reporter/logger；命令实现只能返回 `output` 与 `warnings`，无法表达进度、成功摘要、debug 细节和机器可读事件。

### 命令编排

- `packages/cli/src/commands/install.ts`
  - `installCommand()` 会先 `preparePluginTargetsForCommand(... ensureLocalMarketplace: true)`，再解析目标平台和 skill trigger options。
  - `installTargetsOnPlatforms()` 顺序是：
    1. `adapter.status()`
    2. skill trigger 物化
    3. `adapter.installPlugin()`
    4. `adapter.installExtensions()`
    5. tracking / ledger 写入
    6. 再次 `adapter.status()`，并把 `driftWarnings` 全部推入命令 warnings
  - 失败后按 native/artifact/tracking 写入情况把 `installed.json` 标成 degraded，这个机制可以继续承接 Codex native 命令成功后后续失败的场景。

- `packages/cli/src/commands/common.ts`
  - `resolveTargetPlatforms()` 在双平台可用且 `auto` 无法唯一推断时直接报错，当前没有交互式选择平台的入口。
  - `collectCommandWarnings()` 会在 Codex `project` scope 输出一条技术性说明：Codex native registry 只支持 user scope。
  - `loadPluginTargetsForCommand()` 在没有显式插件名时只返回当前 catalog；只有调用方已经给出插件名且允许 historical fallback 时，才会构造历史插件占位目标。这条入口不能直接承接 `status` 默认枚举和交互式 `uninstall/upgrade` 的历史目标选择。
  - `formatStatusOutput()` 是偏底层的诊断视图。它能输出很多字段，但默认不回答“现在哪些插件可用、哪里坏了、下一步执行什么”；如果用户不传完整 `--platform/--scope`，也容易看不到真正关心的安装状态。

### Codex adapter

- `packages/cli/src/adapters/codex.ts`
  - `CodexAdapter` 构造函数目前只接收 `cwd/env`，没有 `NativeCliRunner` 注入点。
  - `installPlugin()` 对 native 插件只做：
    - `ensureLocalMarketplace()`
    - 读取 user `config.toml`
    - 检查外部 ownership
    - `upsertCodexMarketplaceFile(... MARKETPLACE_NAME='aw', sourceType='local', source=<canonical AW_HOME>)`
    - `upsertCodexPluginEnabledFile(... '<plugin>@aw', enabled=true)`
  - 没有调用 `runNativeCli()`，也没有执行 `codex plugin marketplace add ~/.aw`。
  - `status()` 从 `~/.codex/config.toml` 读取 `[marketplaces.aw]` / `[plugins."<plugin>@aw"]`，并把 `projectTrust=unknown`、skill trigger warning、tracking 缺失等放进 `driftWarnings`。

### Claude adapter 参考实现

- `packages/cli/src/adapters/claude.ts`
  - 构造函数已有 `nativeCliRunner?: NativeCliRunner`。
  - `installPlugin()` 先判断 marketplace 是否需要更新，然后调用：
    - `claude plugin marketplace add <awHome> --scope <scope>`
    - `claude plugin install <plugin>@aw --scope <scope>`
  - 这条链路可以作为 Codex adapter 接入 native CLI 的结构参考。

### Native CLI 工具

- `packages/cli/src/utils/native-cli.ts`
  - 已有 `runNativeCli()`、`NativeCliRunner`、`NativeCliError`、超时和 stderr/stdout 捕获。
  - 捕获到的 stdout/stderr 目前主要在异常里摘要使用，没有进入统一 debug log。
  - `packages/cli/tests/unit/native-cli.test.ts` 只覆盖通用 runner，尚未覆盖 Codex adapter 调用。

### 配置与状态解析

- `packages/cli/src/utils/codex-config.ts`
  - 能解析和写回 `[marketplaces.*]`、`[plugins.*]`、`[projects.*]` 和 `developer_instructions`。
  - `sourcePointsToManifest` 已能识别误把 `.agents/plugins/marketplace.json` 当 marketplace source 的旧错误。
- `packages/cli/src/utils/local-marketplace.ts`
  - `ensureLocalMarketplace()` 会把 embedded bundle 同步到 `~/.aw`，并返回 replay warnings。
  - `readInstalledLedger()` 在账本缺失或非法时返回 degraded ledger。

### 测试现状

- `packages/cli/tests/unit/codex-adapter.test.ts`
  - 已覆盖 Codex hooks、config 写回、project/user 状态等，但没有验证 native `codex` 命令调用。
- `packages/cli/tests/integration/cli.test.ts`
  - 大量命令编排用 `FakeAdapter`，对默认 scope、警告输出和交互模式没有覆盖。
- `packages/cli/tests/unit/cli-entry.test.ts` / `packages/cli/tests/integration/cli-entry.test.ts`
  - 覆盖 `--skill-trigger` 解析和 warning 顺序，但当前预期仍是 `scope: 'project'`。

## 设计目标

1. **Codex native marketplace 安装必须走上游命令。**
   需要原生能力的 Codex 插件安装时，先通过 `codex plugin marketplace add <canonical AW_HOME>` 让 Codex 自己校验 marketplace root 并注册 local source。对 local source 不期待上游复制出 `.tmp/marketplaces/<name>` 这类物化副本。CLI 仍可写 `[plugins."<plugin>@aw"] enabled = true`，除非确认当前 Codex 已提供稳定的 `plugin install` 命令。

2. **命令 options 有统一 normalization。**
   `installCommand/uninstallCommand/upgradeCommand` 入口即使收到 partial raw options，也要补齐 `cwd/scope/platform`，并对非法值返回可读错误，不把错误留给深层状态读取。`statusCommand` 单独使用 filter 型 options，必须保留“用户未传 scope/platform”的状态，不能被默认值提前压成 `user/auto`。

3. **常用命令选项有稳定短名。**
   `scope/platform/skill-trigger/interactive/verbose/debug/json/all` 等常用选项要有一致、可记忆、可测试的短名；不适合缩写的否定项或路径项保持长名，避免误操作。

4. **默认 scope 改为 user。**
   `install/uninstall/upgrade` 的 CLI、命令函数默认值、文档、测试 fixture 和交互式默认选项都统一为 `user`。`project` 继续可显式指定。`status` 的 `--scope` 是过滤条件，不设默认 scope。

5. **交互式模式覆盖 install / uninstall / upgrade，且不破坏脚本化使用。**
   TTY 下允许安装、卸载、升级在缺插件名、平台歧义和可选配置时走 prompt；非 TTY/CI 下保持确定性错误，并给出可复制命令建议。

6. **交互式插件选择来自候选列表。**
   交互模式不让用户手动输入插件名，而是按命令场景展示可选插件：安装来自 catalog，卸载来自已安装或可发现的受管状态，升级来自已安装目标，并结合当前 catalog 标注可升级、需显式处理或不可升级原因。

7. **受管/可发现插件枚举是一等能力。**
   `status` 默认摘要和交互式 `uninstall/upgrade` 不能继续复用 current catalog loader。需要先有一层 discovery helper，从 ledger、tracking、平台原生配置和 runtime evidence 枚举插件名，再把它们解析成 current catalog target 或 historical placeholder。

8. **默认输出说人话。**
   安装成功要告诉用户做了什么；需要用户处理的事项用“注意/下一步”表达；内部 drift 诊断默认不直接用 `Warning: [platform/plugin] ...` 透出，保留到 `aw status` 或 `--verbose`。

9. **日志和 debug 是一等能力。**
   默认输出要足够说明正常执行结果；`--verbose` 展示关键决策；`--debug` / `AW_DEBUG=1` 记录完整排查信息到文件，并在失败时告诉用户日志路径。debug 里可以看到命令为什么这样做，但不能泄露 token、密钥或完整环境变量。

10. **status 是日常状态面板，不只是兜底诊断。**
   `aw status` 默认要主动发现当前机器和项目里的受管状态，给出可读摘要、健康判断和下一步建议。用户不传完整平台、scope 或插件名时，也应该看到有价值的信息；详细字段再交给 `--verbose` / `--debug`。

## 执行计划

### Phase 0：先固定 CLI / command runtime 合同

这一步先于 Phase 1 / 2 / 4 / 5 落地。目标是先把 native runner、交互、输出和 debug 的同一条运行时走线钉住，避免每个 phase 各自补一套入口参数。

- [ ] 新增共享运行时类型，例如 `packages/cli/src/commands/runtime.ts`：
  - `CommandExecutionContext`：命令函数和 adapter 之间共享的上下文。
  - `CliExecutionContext`：CLI entry 层上下文，包含 `cwd`、`env`、`io`、TTY/CI 交互判定和最终 reporter。
  - `CommandExecutionContext` 至少包含 `env`、`adaptersFactory` 或 `adapters`、`nativeCliRunner`、`interactive`、`prompt`、`reporter`、`debugLogger`、`diagnostics`。
  - `diagnostics` 统一承接 CLI 级输出开关：`verbose`、`debug`、`logFile`、`commandName`、`runId`。执行型命令的 `InstallCommandOptions` / `UpgradeCommandOptions` / `CommandOptions` 不重复携带 `verbose/debug/logFile`；这些开关只影响 reporter/debug logger。`status` 因为 `--verbose` / `--json` 会改变状态视图，额外在 `StatusCommandOptions` 保留 `verbose?: boolean`、`json?: boolean`。
  - 固定 `status` 的双层 verbose 语义：`StatusCommandOptions.verbose` 决定状态视图是否展开，`diagnostics.verbose` 决定 reporter 是否向 `stderr` 输出命令决策诊断；CLI entry 可以由同一个 raw `--verbose` 同时设置两者，但渲染出口必须分开。
  - `cwd/scope/platform` 仍来自 normalized command options；runtime 只承载可注入能力和副作用出口，不替代 options normalization。
- [ ] 收敛当前分散的本地 `CommandRuntime`：
  - `install.ts`、`uninstall.ts`、`upgrade.ts`、`status.ts` 不再各自维护字段不一致的 `CommandRuntime` interface。
  - 命令函数统一接收 `CommandExecutionContext` 的 `Partial` 或构造后的 context；默认生产路径由 `createCommandExecutionContext()` 补齐。
  - `createAdapters()` 只从 context 读取 `nativeCliRunner`、`env` 和后续 debug hooks；测试注入 fake adapter/fake runner 时走同一个入口。
- [ ] 明确运行时能力边界：
  - `prompt` / `interactive` 只由 CLI entry 判定和注入；底层命令函数不得直接读 `process.stdin.isTTY`、`process.env.CI`。
  - adapter 可以拿到 `nativeCliRunner` 和 `debugLogger`，用于执行并记录原生命令；adapter 不直接渲染用户输出，也不直接发起 prompt。
  - `context.env` 是命令读取外部环境的唯一来源。新 context、discovery helper、status orchestrator、默认 adapter 创建、平台检测、home 路径解析和 current catalog 解析都必须消费同一份 `context.env`；一旦调用方传入 runtime env，后续 helper 不能退回 `process.env`。
  - 命令函数产出结构化 notices/events；CLI reporter 负责 stdout/stderr/debug log 渲染。过渡期可保留 `warnings: string[]`，但新增路径必须能映射到统一 notices/events。
  - prepare / replay 阶段产生的 warning 必须保留发生顺序；即使最终命令返回终止错误，先发生的 warning 也要先于 terminal error 渲染，不能被 reporter 按 level、来源或错误优先级重排到错误之后。
  - 同一条 prepare 阶段 warning 在一次 CLI 调用中只能渲染一次。若 warning 同时经过 prepare 结果、command result 或最终 reporter 聚合，必须用稳定 identity 去重，同时保留首次出现位置。
  - `status` 使用同一份 context，但保持只读合同；它可以读取 `env`、adapter、debug logger，不能通过 context 间接触发 repair/sync 写入。
- [ ] 在 `CliRuntimeOptions` / `buildProgram()` / `runCli()` 只暴露这一套注入入口：
  - `cwd/env/io` 继续支持。
  - 新增 `adaptersFactory` 或 `adapters`、`nativeCliRunner`、`prompt`、`interactive`、`reporter`、`debugLogger`。
  - 新增 CLI 级诊断输入归一化：Commander raw options、`AW_DEBUG=1` 和测试注入的 runtime diagnostics 都汇入同一个 `diagnostics`，再创建 reporter/debug logger。
  - `--debug` 和 `AW_DEBUG=1` 都隐含 `verbose=true`；显式 `--log-file <path>` 只决定 debug log 路径，不单独开启 verbose，除非同时传 `--debug` 或设置 `AW_DEBUG=1`。
  - `status --json` 独占 `stdout`：成功时 `stdout` 只能是一份可解析 JSON，不混入人类摘要、verbose 文案、debug log 路径提示或 warning 前缀。`status --json --verbose` 允许并存，但 verbose 状态细节必须进入 JSON payload 的稳定字段；reporter 诊断只进 `stderr`。`status --json --debug` / `AW_DEBUG=1 aw status --json` 也必须保持同样边界，debug log 路径和额外诊断写到 `stderr` 或 debug log。
  - debug log 默认落点由命令类型决定：写命令默认写入 `~/.aw/logs/aw-<timestamp>-<command>.log`；`status` 未传 `--log-file` 时默认写入系统临时目录下的 `agent-workflows/aw-<timestamp>-status.log`，不能为了 debug log 创建或清理 `~/.aw`。
  - CLI action 调用 `installCommand/uninstallCommand/upgradeCommand/statusCommand` 时必须透传同一个 context，不在 action 内临时拼命令专用对象。
- [ ] 增加 runtime 合同测试：
  - CLI entry 注入 fake native runner 后，`install/upgrade` 和 Codex adapter 看到的是同一条 runner 走线，不需要临时 stub binary。
  - `status` 通过同一 context 接收 fake adapters/debug logger，但默认读取路径不调用 native runner。
  - CLI entry 注入 fake prompt 后，交互式 `install/uninstall/upgrade` 不访问真实 stdin。
  - `--verbose` / `--debug` 的 reporter/debug logger 能收到 command events 和 native invocation events。
  - `AW_DEBUG=1` 与 `--debug` 进入同一条 debug logger 走线，且都隐含 verbose；`--log-file` 指定的路径被 debug logger 使用。
  - `aw status -j`、`aw status -j --verbose`、`aw status -j --debug`、`aw status -j --verbose --debug` 的 `stdout` 都必须保持纯 JSON；如果有 verbose/debug 人类诊断，只能出现在 `stderr` 或 debug log。
  - `statusCommand(..., { env })` 不注入 adapter 时，平台检测、默认 adapter 创建、ledger/current catalog 解析和 home 路径都来自同一个 runtime env。
  - `runCli(..., { env })` 走完整 CLI entry 时，fake runner、context、discovery、status 和默认 adapter 都不能回落到 `process.env`。
  - direct command 调用不传 runtime 时仍走生产默认值；传 partial runtime 时缺省字段由统一 context builder 补齐。

### Phase 1：统一 options normalization、短选项与 user scope 默认值

- [ ] 新增命令 options normalizer，例如 `packages/cli/src/commands/options.ts`：
  - `normalizeCommandOptions(raw, { cwd, defaultScope: 'user', defaultPlatform: 'auto' })`：只服务 `install/uninstall/upgrade` 这类执行型命令。
  - `normalizeInstallCommandOptions(...)`
  - `normalizeUpgradeCommandOptions(...)`
  - `normalizeStatusCommandOptions(raw, { cwd })`：返回独立的 `StatusCommandOptions`，其中 `scope?: Scope`、`platform?: 'codex' | 'claude' | 'both'` 都是过滤条件；用户未传时必须保留为未指定，不能默认成 `user`。
  - `raw.platform === 'auto'` 在 status 中按“未指定平台过滤”处理，以兼容旧命令习惯；执行型命令仍按 `auto` 进入平台推断。
  - 对 `scope/platform/skillTrigger` 做统一校验，错误信息和 Commander 层保持一致。
- [ ] 固定短选项命名，所有 CLI 入口和文档使用同一套约定：
  - `-s, --scope <scope>`：`project | user`。
  - `-p, --platform <platform>`：`codex | claude | both | auto`。
  - `-t, --skill-trigger <preference>`：`default | manual | auto`，只用于 `install` 和显式插件 `upgrade`。
  - `-t` / `--skill-trigger` 在显式 `install` 和显式插件 `upgrade` 中必须进入 normalized `requestedSkillTrigger` 并影响最终 materialization；`upgrade --all` 继续拒绝该选项。
  - `-i, --interactive`：强制进入交互确认流程，适用于 `install/uninstall/upgrade`。
  - `--no-interactive`：保持长名，不设计短名，避免和常见 `-n` / `--dry-run` 语义混淆。
  - `-a, --all`：`upgrade` 专用。
  - `-v, --verbose`：展示关键决策。
  - `-D, --debug`：开启 debug log，并隐含 `--verbose`。
  - `-j, --json`：`status` 专用 JSON 输出。
  - `-f, --force`：`init` 专用，刷新本地 marketplace bundle。
  - `--log-file <path>`：保持长名，路径型选项不设短名。
- [ ] 调整 `index.ts`：
  - `init` 的 `.option('-f, --force', ...)`
  - `install/uninstall` 的 Commander 参数从 `.argument('<plugins...>')` 改成 `.argument('[plugins...]')`；缺少插件名时不能再由 Commander 在 parse 阶段拦截，必须先进入 CLI runtime 的交互/非交互决策。
  - 缺插件名的校验迁到 CLI runtime 决策之后：TTY 且允许交互时进入插件选择；非 TTY、`CI=true` 或 `--no-interactive` 时返回确定性业务错误，并保留清晰示例。
  - `install/uninstall/upgrade` 使用 `.option('-s, --scope <scope>', 'project or user', 'user')`
  - `install/uninstall/upgrade` 使用 `.option('-p, --platform <platform>', 'codex | claude | both | auto', 'auto')`
  - `status` 使用 `.option('-s, --scope <scope>', 'filter by scope')`，Commander 层不写默认值。
  - `status` 使用 `.option('-p, --platform <platform>', 'filter by platform')`，Commander 层不写默认值；显式传 `auto` 时由 `normalizeStatusCommandOptions()` 归一成未指定过滤。
  - `install/upgrade` 的 `.option('-t, --skill-trigger <preference>', ...)`
  - `upgrade --all` / `upgrade -a` 如果同时收到 `--skill-trigger` 或 `-t`，仍在 CLI entry / command 入口层返回当前确定性错误，不进入 all preflight，也不把偏好静默丢弃。
  - `install/uninstall/upgrade` 增加 `.option('-i, --interactive', ...)` 与 `.option('--no-interactive', ...)`
  - `upgrade` 的 `.option('-a, --all', ...)`
  - `install/uninstall/upgrade/status` 都挂 `.option('-v, --verbose', ...)`、`.option('-D, --debug', ...)` 和 `.option('--log-file <path>', ...)`；这些 raw options 不进入执行型 command options，而是进入 Phase 0 的 `diagnostics`。
  - `status` 后续增加 `.option('-j, --json', ...)`
  - `toCommandOptions()` 默认改为 `user`，并只用于执行型命令。
  - 新增 `toStatusCommandOptions()`，不要复用 `toCommandOptions()`。
  - 新增 `toCliDiagnosticsOptions()` 或等价 helper，把 `verbose/debug/logFile` 与 `AW_DEBUG=1` 合并后传给 `createCliExecutionContext()`；`status --verbose` 同时写入 `StatusCommandOptions.verbose` 和 runtime diagnostics，保证默认/verbose/json 渲染与 reporter 走线一致。
  - 单元测试中 `install/upgrade/uninstall` 的默认 scope 预期全部改为 `user`；`status` 预期改为不携带 scope/platform filter。
- [ ] 在命令函数入口也调用 normalization 或新增 raw command API，避免绕过 CLI 入口时传入不完整 options 直接崩溃。
- [ ] 增加回归测试：
  - `installCommand(['git-commit'], { cwd } as any, ...)` 不再抛 undefined 访问，而是按 user/auto 默认值执行或返回业务错误。
  - `uninstallCommand(['git-commit'], { cwd } as any, ...)` 不再抛 undefined 访问，而是按 user/auto 默认值执行或返回业务错误。
  - `upgradeCommand(['git-commit'], { cwd } as any, ...)` 不再抛 undefined 访问，而是按 user/auto 默认值执行或返回业务错误。
  - `upgradeCommand([], { cwd, all: true } as any, ...)` 同样覆盖 partial options 入口，确保 `--all` 路径也经过 normalization。
  - `statusCommand([], { cwd } as any, ...)` 不再抛 undefined 访问，并按未指定 scope/platform filter 进入 status 聚合流程。
  - 非法 `scope/platform` 的错误仍是明确的 `Unsupported ...`。
  - `aw init -f`、`aw install git-commit -p codex -s user -t manual`、`aw upgrade -a -p both`、`aw status -j` 能和长选项得到同样的 raw options，且 `aw status -j` 不隐式带上 `scope=user`。
  - `aw install git-commit -v`、`aw install git-commit -D --log-file <tmp>`、`aw uninstall git-commit --verbose`、`aw upgrade git-commit --debug`、`aw status --verbose --debug --log-file <tmp>` 都能把诊断开关送到同一个 reporter/debug logger，不在各命令 action 里各自解析。
  - `AW_DEBUG=1 aw status git-commit` 与 `aw status git-commit --debug` 产生等价 diagnostics；`--debug` / `AW_DEBUG=1` 都隐含 verbose，`--log-file` 指定路径被使用。
  - `runCli(['install'])` / `runCli(['uninstall'])` 在缺插件名时必须穿过 Commander 参数层；本阶段先覆盖非交互业务错误路径，Phase 4 再用 fake prompt 覆盖交互路径，stderr 不能退化成 Commander 的 missing argument 文案。
  - `runCli(['install', ..., '--skill-trigger', 'manual|auto|default'])` 继续把偏好传入最终 materialization 结果；至少覆盖 Codex runtime 中 `allow_implicit_invocation` 或等价产物变化。
  - `runCli(['upgrade', '<plugin>', ..., '--skill-trigger', 'manual|auto|default'])` 继续保持显式插件 upgrade 的同一透传合同。
  - `runCli(['upgrade', '--all', ..., '--skill-trigger', 'manual'])` 继续在 CLI entry / command 入口层返回确定性错误；`-t manual` 短选项覆盖同样语义，不能静默忽略，也不能晚到深层流程才失败。
- [ ] 同步文档：
  - `README.md`
  - `docs/plugin-installation.md`
  - `docs/architecture.md` 中涉及默认 scope 的描述。

### Phase 2：Codex adapter 接入 native marketplace 命令

- [ ] 把 `CodexAdapter` 构造函数扩展为：
  - `constructor(cwd: string, nativeCliRunner?: NativeCliRunner, env = process.env)`
  - `createAdapters(cwd, env, { nativeCliRunner? })` 默认从 Phase 0 的 `CommandExecutionContext` 取得 runner；Claude/Codex adapter 共用同一套 native runner 注入模型。
- [ ] 补齐 CLI entry 层的可测注入缝，避免 `runCli()` 集成测试在 `PATH=''` 时误触真实 `codex`：
  - `CliRuntimeOptions` / `buildProgram()` 使用 Phase 0 的统一 runtime 注入，例如 `adaptersFactory` 或 `nativeCliRunner`；CLI action 调用 `installCommand/uninstallCommand/upgradeCommand/statusCommand` 时必须把同一个 context 继续传下去。
  - 现有 `cwd/env/io` 注入保持不变；新增注入只服务测试、debug 和后续交互式 runtime，不改变普通用户路径。
  - `createAdapters()` 仍是默认生产路径；测试可通过 fake runner 验证 `runCli(['install', ...])` 的 native add 行为，不依赖临时真实可执行文件。
  - 不采用“所有 CLI entry integration 都临时造 stub binary 进 PATH”的默认策略；若某个测试确实要验证 PATH 查找，再单独用 stub binary。
- [ ] 新增 Codex native command helper：
  - `buildCodexMarketplaceAddInvocation(awHome, cwd, env)`
  - 命令形态已按 `/Users/LeslieChan/Desktop/codex/codex-rs` 当前源码确认：`codex plugin marketplace add <canonical AW_HOME>`，local directory source 不需要也不应该附加 `--ref` 或 `--sparse`。
  - 对照点：
    - `cli/src/main.rs` 只暴露 `codex plugin marketplace` 命名空间，`PluginSubcommand` 当前只有 `Marketplace`。
    - `cli/src/marketplace_cmd.rs` 的 `AddMarketplaceArgs` 是一个必填 `source` positional，外加 git source 专用的 `--ref` 和 `--sparse`。
    - `core-plugins/src/marketplace_add/source.rs` 会把本地目录 canonicalize；本地 source 如果是文件会拒绝，且 `--ref` / `--sparse` 只允许用于 git source。
    - `core-plugins/src/marketplace_add.rs` 对 local directory source 只记录 user config，不复制到 marketplace install root。
  - 已核对的上游行为：local directory source 会校验 marketplace root、canonicalize source path 并写入 Codex user config；不会像 git/http source 一样复制到 `.tmp/marketplaces/<name>`。实现和 status 不要把“local source 已注册”误判成“必须存在物化副本”。
- [ ] 修改 `CodexAdapter.installPlugin()`：
  - `requiresNativePlugin(plugin) === false` 时仍不写 native state。
  - 需要 native state 时先 `ensureLocalMarketplace()`，取 `resolveAwHomeCanonical()`。
  - 若 `[marketplaces.aw]` 缺失、`source` 不是 canonical AW_HOME、`source_type` 不是 `local`、或 `sourcePointsToManifest=true`，调用 `runNativeCli({ command: 'codex', args: ['plugin','marketplace','add', awHome], ... })`。
  - 调用后重新读取 `~/.codex/config.toml`，校验 marketplace 确实指向 AW_HOME；失败时抛出面向用户的动作型错误，不能只透出 `Command exited with code ...`。错误包装需要覆盖 stderr/stdout 摘要、空输出、timeout 和可执行文件缺失。
  - 保留 `upsertCodexPluginEnabledFile()` 作为插件启用步骤。当前 `codex-rs` CLI 源码没有暴露稳定的 `codex plugin install <plugin>@aw` 子命令；这一轮不要把启用步骤切到不存在的 native install。未来上游新增稳定命令时，再作为单独行为变更处理。
- [ ] 保持现有 rollback/degraded 语义：
  - native command 成功后后续 artifact/tracking 失败，仍标记 `operation_interrupted_after_native_write`。
  - 不在失败回滚里盲目删除 `[marketplaces.aw]`，删除仍走现有 shared refs 全账本扫描策略。
- [ ] 增加测试：
  - Codex native 插件安装会调用 fake runner：`codex plugin marketplace add <awHome>`。
  - fake runner 断言 invocation 参数精确为 `['plugin', 'marketplace', 'add', awHome]`；local AW_HOME source 不带 `--ref`、`--sparse` 或其它未确认 flag，且传入的是 canonical marketplace 根目录，不是 `.agents/plugins/marketplace.json`。
  - marketplace 已正确注册且 source/source_type 匹配时不重复调用 native add。
  - source 指向旧 manifest 文件或错误目录时会调用 native add 修复。
  - native add 失败时错误包含用户能理解的动作和原始 stderr 摘要。
  - local source 注册成功后不要求 `.tmp/marketplaces/aw` 存在。
  - instruction-only Codex 插件不调用 native add。
  - `runCli(['install', 'git-commit', '--platform', 'codex'])` 通过 CLI runtime fake runner 成功完成 native add，不要求测试环境存在真实 `codex`。
  - `runCli(...)` 在 fake runner 返回失败时，退出码为 1，并渲染用户可读的 native add 失败信息和 stderr 摘要。
  - fake runner 抛出无 stderr / 无 stdout 的 `NativeCliError` 时，CLI 仍输出“注册 Codex marketplace 失败”这类动作型错误，并给出下一步建议。
  - timeout 场景会提示原生命令超时，不能只剩 `exit code 124`。
  - `codex` 不可执行、PATH 异常或 `ENOENT` 时，用户能看到明确的前置条件或修复建议。
  - `--debug` 日志保留原始 exit code、stdout/stderr 摘要、invocation command/args/cwd 和 cause 类型，便于维护者排查。
  - 保留或更新现有 `AW_FORCE_CODEX_AVAILABLE=1` + `PATH=''` 的 CLI entry 用例，确保它们不会因为接入 native add 而误炸。

### Phase 3：受管/可发现插件 discovery 层

这一步先补齐 `status` 和交互式 `uninstall/upgrade` 共同需要的目标枚举能力，避免后续继续把 current catalog loader 当成通用入口。

- [ ] 新增 discovery helper，例如 `packages/cli/src/commands/discovery.ts`：
  - `discoverManagedPluginNames({ cwd, scopeFilter, platformFilter, env })`
  - `resolveDiscoveredPluginTargets({ cwd, scopeFilter, names, env })`
  - `buildCommandCandidates({ command: 'status' | 'uninstall' | 'upgrade', ... })`
  - helper 入口先派生平台差异化的 project identity，不能把所有 project scope 都折叠到 repo root：
    - Codex project scope：先解析 repo root，`projectKey = realpath(repoRoot)`；tracking、repo-managed artifacts 和 Codex project native evidence 都锚定 repo root。
    - Claude project scope：沿用当前基线语义，`projectKey = realpath(cwd)`，`resolveClaudePaths(cwd, 'project')` 继续指向调用目录下的 `.claude/`；同一仓库不同子目录的 Claude project 安装必须保持隔离。
    - discovery 输出要显式携带 `projectKey`、`projectRoot` 或 `executionCwd` 的来源，避免后续 status / 交互式命令把 Claude 子目录证据误合并成 repo 级证据。
- [ ] 插件名枚举来源按证据合并、去重并保留稳定顺序：
  - AW ledger：Codex user/project scopes、Claude user/project scopes，包括 degraded ledger 中仍可读取的记录。
  - tracking manifest：当前 project/user scope 下 `.agent-workflows-manifest.json` 记录的插件名。
  - Codex native/user config：`[plugins."<plugin>@aw"]`、`[marketplaces.aw]`、shared native refs 能证明的 AW 管理痕迹。
  - Claude native/runtime evidence：已注册的 `@aw` marketplace/plugin、scope settings 和项目路径匹配证据。
  - 当前 catalog：只用于补充 metadata 和安装候选，不作为 `status` / `uninstall` / `upgrade` 的唯一来源。
- [ ] 目标解析分两步：
  - 先得到插件名和证据摘要，不在枚举阶段直接丢掉 current catalog 已删除的插件。
  - 再把每个名字解析成 current catalog target；找不到当前 catalog 条目时，用 historical placeholder 承接 `status`、`uninstall` 和可提示的 `upgrade` 分支。
  - current catalog 解析必须沿用 runtime env，并保留 catalog resolution 诊断：当 `~/.aw` 缺失、`config.json` stale 或本地 marketplace 布局不健康时，discovery/status 读取 current catalog 要回退 embedded catalog，结果里能区分 `source=embedded` 与本地目录不可用原因；这个回退不能触发同步、repair 或任何 `~/.aw` 写入。
- [ ] historical target 的身份必须按 `(pluginName, platform, scope)` 建模，不能生成一个跨 scope/platform 的 union manifest：
  - discovery 可以在 UI 层把同名插件聚合展示，但传给 adapter 的 target 必须对应单个 `platform + scope` 格子。
  - `createHistoricalPluginMeta()` 或替代 helper 需要接收 `platform`、`scope` 和该格子的 evidence，只把同一格子的 tracking / ledger / native 证据写进 placeholder manifest。
  - Codex historical placeholder 恢复具体 repo-managed artifact kind 时，tracking manifest 里的 artifact kind / hook identities 仍是主要真值；`CodexCapabilitySnapshot.hasRepoManagedArtifacts` 只能说明历史上曾经写过 repo-managed artifact，不能单独恢复 `instructions`、`permissions`、`hooks`、`agents` 或 native hook 明细。
  - current catalog 缺失且 Codex 侧只有 ledger coarse boolean（例如只有 `hasRepoManagedArtifacts: true`）时，discovery / status / 交互式候选必须返回 `unknown`、禁用态或等价保守结论；不能把该 target 合成为 hook-capable 或其它具体 repo-managed 能力。只有 tracking 明确记录 `kind: "hook"` 或等价 hook identity 证据时，才恢复 Codex hook 能力。
  - `status` orchestrator 对矩阵逐格调用 `adapter.status(target.plugin, scope)`；不得把 project-only repo artifacts 合进 user scope，也不得把 user native capability 合进 project scope。
  - `evidenceByPlatformScope` 是聚合展示和 health 判断的来源；adapter 的 `status()` 仍只消费当前格子的 manifest 与 scope。
- [ ] discovery 输出要携带命令可用性信息：
  - `selectable`：本次命令可以安全处理的候选。
  - `disabledReason`：能展示但不能直接处理的原因，例如 catalog missing、external ownership、ledger degraded 需要显式参数。
  - `evidenceByPlatformScope`：供 status 聚合和交互式列表展示。
- [ ] 明确边界：
  - `loadPluginTargetsForCommand()` 保留给 install 和显式插件名解析，不再作为无参数 `status`、交互式 `uninstall`、交互式 `upgrade` 的默认枚举入口。
  - discovery helper 不直接执行 install/uninstall/upgrade，只返回候选和证据，最终仍走命令函数既有安全检查。
- [ ] 增加测试：
  - current catalog 已删除，但 ledger 仍有记录时，`uninstall` 和 `status` 候选仍能列出该插件。
  - 只有 tracking manifest 证据、没有 ledger 证据时，候选仍能出现并标注证据来源。
  - 只有 Codex native `plugin@aw` 或 shared native refs 证据时，status 能列出，交互式卸载按现有外部/受管保护给出可处理或禁用状态。
  - current catalog 已删除，且同一插件只存在于 `project` scope 时，默认 `aw status <plugin>` 不能把它误报成 `user` scope 可用。
  - current catalog 已删除，且同一插件在 `user` 与 `project` 都有证据时，默认 `aw status <plugin>` 必须分别输出两格状态，不能把两侧能力混成一份 placeholder。
  - 从 repo 子目录运行 discovery 时，Codex project tracking manifest、Codex project ledger、Codex project native evidence 的解析结果必须与从 repo root 运行一致。
  - 从 repo 子目录运行 discovery 时，Claude project scope 仍以子目录真实路径为 key；如果只有 repo root `.claude/` 有安装证据，子目录调用不能把它误报成当前 Claude project 安装。
  - 从 repo 子目录运行交互式 `uninstall` / `upgrade` 候选构建时，当前 repo 的 Codex project scope 安装仍出现在候选列表中，且 candidate 的 `platform + scope + projectKey` 指向 repo root。
  - 从 repo 子目录运行交互式 `uninstall` / `upgrade` 候选构建时，Claude project candidate 的 `projectKey` 指向调用子目录；不能和 repo root 或兄弟子目录的 Claude project candidate 合并。
  - 走新 discovery / status 默认路径时，Codex current catalog 缺失且 ledger-only 只有 `hasRepoManagedArtifacts: true` 的历史插件不会被恢复成 hook-capable 或其它具体 repo-managed 能力；结果应标成 `unknown`、禁用态或等价保守状态。
  - 走交互式 `uninstall` / `upgrade` 候选构建时，上述 Codex ledger-only 历史插件不能因为 placeholder 过宽而被误判为可直接处理；candidate 必须带明确 `disabledReason` 或保守证据说明。
  - current catalog 缺失但 Codex tracking 明确记录 `kind: "hook"` 或 hook identity 时，新 discovery / status / 交互式候选路径仍能恢复 hook 能力；只有这类明确证据才允许恢复。
  - catalog/current/historical 名字去重后顺序稳定。
  - discovery 遇到某个平台或 scope 读取失败时，只把对应证据标成 `unknown`，不要让整个列表失败。

### Phase 4：交互式模式

- [ ] 新增轻量交互层，建议首版使用 Node `readline/promises`，避免为了少量 prompt 引入新运行时依赖。
- [ ] 新增 `CliPrompt` 抽象，测试可注入：
  - `selectPlatform({ available, defaultValue })`
  - `selectScope({ defaultValue: 'user' })`
  - `selectPlugins({ command, candidates, defaultValues, allowMultiple })`
  - `selectUpgradeMode({ canUpgradeAll, candidates })`
  - `selectSkillTrigger({ defaultValue: 'default', allowSkip: true })`
- [ ] 固定交互式 candidate / selection 的身份模型：
  - `CommandCandidate` 至少包含 `id`、`pluginName`、`platform`、`scope`、`projectKey?`、`executionCwd`、`selectable`、`disabledReason?` 和 evidence summary。
  - `install` candidate 额外携带 `compatiblePlatforms` 或等价的 `marketplace.policy.products` 归一化结果，CLI runtime 必须用它在 prompt 层约束平台选择和插件候选；命令层的 `assertPluginsSupportPlatforms()` 继续作为最后防线。
  - `install` candidate 还要携带目标 `scope + platform` 下的可安装性，至少包含 `installable` / `disabledReason` 或等价字段。平台兼容只回答“插件声明支持哪些产品”，可安装性还要回答“这个插件能否写入当前目标格子”。当前基线必须固定一条规则：`scope=project` 且 `platform=codex` 时，只有 `hasRepoManagedArtifacts(plugin) === true` 的插件可安装；纯 native-only 的 Codex 插件不能作为可选目标。
  - 对 `uninstall` / `upgrade`，同名插件跨 platform 或 scope 共存时必须生成多个可区分 candidate；UI 可以按插件名分组展示，但用户最终选择的是具体 candidate id，不是模糊插件名。
  - prompt 返回 `CommandCandidateSelection[]` 或等价 token，CLI runtime 校验 token 必须来自本轮候选列表，且保留 `platform + scope + projectKey` 身份。
  - 在进入现有命令函数前，CLI runtime 按 `platform + scope + executionCwd` 分组选中 candidate；每组再调用一次普通命令 API，并传入该组的 `plugins: string[]`、固定 `platform`、固定 `scope` 和对应 `cwd`。
  - `install` 固定采用“先锁定 scope/platform，再展示候选”的路径：先用已传参数、默认值和必要 prompt 得到目标 `scope` 与目标平台集合；如果用户选择 `both`，则视为 Codex + Claude 两格的成组安装。随后 catalog 候选只展示或允许选择与该目标平台集合兼容、且在每个目标 `scope + platform` 格子里可安装的插件。
  - 对显式插件名的交互式 `install`，runtime 先根据整组插件的 `compatiblePlatforms` 交集收窄平台 prompt。单个插件时，只支持 `CODEX` 的插件不能选择 `claude` 或 `both`，只支持 `CLAUDE` 的插件同理。多个显式插件名时，必须存在共同兼容平台集合才能继续；如果 `<codex-only-plugin>` 与 `<claude-only-plugin>` 没有共同集合，runtime 在 dispatch 前给出业务错误，并提示用户分开安装或回到候选列表收窄选择。
  - 显式多插件名的交互式 `install` 不按插件兼容性自动拆成多次 `installCommand()` 调用。`platform=both` 只有在所有显式插件同时支持 Codex 和 Claude 时才可继续；`platform=codex` / `platform=claude` 也必须被整组插件共同支持。如果 fake prompt 返回不兼容平台，必须在 runtime 层拒绝并重新提示或报业务错误，不能等到 `installCommand()` / `resolveTargetPlatforms()` 深层失败。
  - 对无插件名的交互式 `install`，如果双平台 `auto` 无法唯一推断，先选择平台；插件候选按锁定后的平台集合过滤。选择 `both` 时，只支持单平台的插件不作为可选项，或显示为禁用项并带明确原因。
  - 对 `scope=project` 且目标平台包含 `codex` 的交互式 `install`，候选构建必须额外执行 `hasRepoManagedArtifacts(plugin)` 判断。无插件名路径下，纯 native-only 插件要么隐藏，要么禁用并说明 `Codex project scope 只安装 repo-managed artifacts`；如果过滤后没有可安装插件，返回可读空态。显式插件名路径下，如果用户最终选择 `codex + project` 且任一目标插件不满足该条件，runtime 必须在 dispatch 前拒绝或要求重选，不能晚到 `CodexAdapter.installPlugin()` 才失败。
- [ ] 插件选择必须来自候选列表，不再让用户手动输入插件名：
  - `install` 候选来自当前 catalog，展示插件名、摘要、支持平台和能力提示；没有候选时直接给出可读错误。
  - `uninstall` 候选来自 Phase 3 discovery helper 汇总的 AW ledger、tracking manifest 和平台可发现受管状态；ledger degraded 时也可以列出“可发现但状态未知”的目标，并在确认后沿用现有 degraded 保护。
  - `upgrade` 候选来自 Phase 3 discovery helper 汇总的已安装插件，再结合当前 catalog 标注 `current/missing/capabilityChanged` 等状态；可选项只包含本次 `upgrade` 能处理的目标，缺失或外部管理目标可以显示为禁用项并给下一步建议。
  - `upgrade` 同时提供“全部可升级”选项，并复用非交互 `--all` 的候选构建和 preflight；这不是 safe-subset 快捷方式。
  - `upgrade --all` 的首版合同保持当前实现的 fail-fast：只要候选集中存在 `disabledReason`、外部 ownership、`catalogCompatibility !== current`、`scopeInitialized !== yes`、平台产品不匹配或 degraded 阻断项，就在任何写入前整体失败，并列出阻断项。
  - 交互式“全部可升级”只有在 `--all` preflight 可以通过时才可选；若存在禁用项，列表中展示阻断原因，并提示用户显式选择可处理插件或先清理阻断项。
  - 用户在交互式里手动勾选安全子集时，最终按 candidate 所属的 `platform + scope + executionCwd` 分组后转成普通命令调用，每组 `all: false`；这条路径不声称等价于 `--all`。
  - 多选结果要保持用户选择顺序；若选中多个 platform/scope 格子，CLI runtime 只能按格子拆分调用或先要求用户收窄选择，不能丢掉 candidate 身份后执行一条模糊命令。
  - 交互式“全部可升级”复用 `upgrade --all` preflight 时，也必须带上明确的 scope/platform 过滤；如果 UI 允许跨格子全选，runtime 要逐格 preflight，并在任何写入前汇总阻断项。
- [ ] CLI 行为：
  - `aw install` 在 TTY 下允许无插件名，进入 catalog 插件选择；非 TTY 仍报“install 命令至少需要一个插件名”，并提示示例。
  - `aw uninstall` 在 TTY 下允许无插件名，进入已安装插件选择；非 TTY 仍报“uninstall 命令至少需要一个插件名”，并提示示例。
  - `aw upgrade` 在 TTY 下允许无插件名且未传 `--all`，提示选择单个/多个插件或“全部可升级”；非 TTY 下沿用确定性错误或现有 `--all` 语义。
  - `aw install git-commit` / `aw uninstall git-commit` / `aw upgrade git-commit` 默认 `scope=user`、`platform=auto`；如果 auto 在双平台下无法唯一推断且 TTY 可交互，则提示选择 `codex/claude/both`。
  - `--interactive` / `-i` 强制进入确认式 prompt，即使已有插件名和默认值，也允许用户重新选择插件、scope、platform，以及适用时的 skill-trigger。
  - `--no-interactive` 或 `CI=true` 禁止 prompt，保持脚本友好。
- [ ] degraded ledger 下的 `skill-trigger` 交互补偿必须在 dispatch 前完成：
  - CLI runtime 在确定 `plugins + platform + scope` 后、调用 `installCommand()` / 显式插件 `upgradeCommand()` 前，检查当前 ledger 是否 degraded，以及本次是否会触发现有命令层“必须显式给出 `requestedSkillTrigger`”的路径。
  - 重复 `install` 命中已受管目标，且 ledger degraded、用户未传 `--skill-trigger`、交互可用时，调用 `selectSkillTrigger({ defaultValue: 'default', allowSkip: false })` 补齐 `requestedSkillTrigger`。
  - 显式插件 `upgrade` 命中 ledger degraded、用户未传 `--skill-trigger`、交互可用时，也调用 `selectSkillTrigger({ defaultValue: 'default', allowSkip: false })` 补齐 `requestedSkillTrigger`。
  - `CI=true`、`--no-interactive`、非 TTY 或没有可用 prompt 时，不自动补问，继续保持现有确定性错误，提示用户显式传 `--skill-trigger default|manual|auto`。
  - fake prompt 返回 skip、空值或非法 `skill-trigger` 时必须在 runtime 层拒绝并给出业务错误；不能把非法值传给命令层，也不能退回隐式继承。
- [ ] 命令层不要直接依赖 `process.stdin.isTTY`，由 Phase 0 的统一 runtime 注入 `interactive: boolean` / `prompt`，方便测试。
- [ ] 交互式文案原则：
  - 默认选项排第一，例如 `user (默认)`。
  - 插件选择用勾选列表、编号选择或等价的选择控件表达；提示文案不出现“请输入插件名”。
  - 候选列表很长时支持过滤，但过滤只缩小列表，最终选择仍必须命中已有候选。
  - 平台选择展示检测结果，不显示内部 `scopeInitialized` 术语。
  - prompt 结果最终仍走同一套 normalized options 和 command functions。
- [ ] 增加测试：
  - `runCli(['install'], { prompt: fakePrompt })` 能通过 catalog 候选选择插件，并成功调用 `installCommand`；断言命令已经穿过 Commander 参数层，而不是被 `<plugins...>` 拦截。
  - `runCli(['uninstall'], { prompt: fakePrompt })` 能通过已安装候选选择插件，并成功调用 `uninstallCommand`；断言命令已经穿过 Commander 参数层，而不是被 `<plugins...>` 拦截。
  - `runCli(['upgrade'], { prompt: fakePrompt })` 能选择具体插件或“全部可升级”，并成功调用 `upgradeCommand`。
  - `runCli(['uninstall'], { cwd: <repo-subdir>, prompt: fakePrompt })` 能在候选列表里看到 repo root 的 Codex project scope 安装，并把最终 command options / candidate evidence 锚定到 repo root。
  - `runCli(['upgrade'], { cwd: <repo-subdir>, prompt: fakePrompt })` 能在候选列表里看到 repo root 的 Codex project scope 安装；若选择“全部可升级”，preflight 使用 repo root 的 Codex projectKey。
  - `runCli(['uninstall' | 'upgrade'], { cwd: <repo-subdir>, prompt: fakePrompt })` 构建 Claude project 候选时只使用子目录 projectKey；repo root 或兄弟子目录的 Claude 安装不会混进本轮候选。
  - mixed safe/blocked 候选下，非交互 `upgrade --all` fail-fast 且不会写任何平台状态；交互式“全部可升级”同样不可继续或得到同一类阻断错误。
  - mixed safe/blocked 候选下，交互式显式勾选安全子集会以普通插件列表执行，不设置 `all: true`，并在输出中说明未处理的禁用项。
  - 交互式插件 prompt 不调用自由文本输入，fake prompt 返回 catalog/ledger 之外的插件名时会被拒绝。
  - `runCli(['uninstall'], { prompt: fakePrompt })` 能选择一个 current catalog 已删除但 ledger/tracking/native 仍有证据的历史插件。
  - `runCli(['upgrade'], { prompt: fakePrompt })` 会展示 catalog missing 的历史插件为禁用项，并给出清理或显式处理建议。
  - 同名插件同时存在于 Codex / Claude 两个平台时，交互式 `uninstall` / `upgrade` 可以只选择其中一个平台的 candidate，最终只调用该平台对应命令，不误操作另一侧。
  - 同名插件同时存在于 user / project 两个 scope 时，交互式 `uninstall` / `upgrade` 可以只选择其中一个 scope 的 candidate，最终只处理该 scope。
  - 同名插件一侧 candidate 有 `disabledReason`、另一侧可处理时，prompt 展示和选择校验不能把两侧状态按插件名混在一起。
  - fake prompt 返回合法插件名但错误 candidate id、错误 platform/scope 或过期 token 时会被拒绝，不会退回按插件名执行。
  - 双平台 `auto` 歧义时，TTY prompt 返回 `codex` 后继续安装。
  - 只支持 `CODEX` 的插件在交互式 `install` 中不会被当成 `claude` 或 `both` 的有效候选；只支持 `CLAUDE` 的插件同理。
  - 对显式插件名执行 `aw install <codex-only-plugin> -i` 时，平台 prompt 不能接受 `claude` 或 `both`；fake prompt 强行返回不兼容平台时会被 runtime 拒绝，不会晚到 `installCommand()` 才失败。
  - 对显式多插件名执行 `aw install <codex-only-plugin> <claude-only-plugin> -i` 时，runtime 在 dispatch 前识别整组插件没有共同兼容平台并返回可读错误；不会先进入 `installCommand()` 深层平台解析，也不会自动拆成两次安装。
  - 对显式多插件名执行 `aw install <codex-only-plugin> <both-plugin> -i` 时，平台 prompt 只能接受 `codex`；fake prompt 强行返回 `claude` 或 `both` 会被 runtime 拒绝，不会晚到 `installCommand()` 才失败。
  - 对无插件名执行 `aw install -i` 且用户先选择 `both` 时，catalog 列表只允许选择同时支持 Codex 和 Claude 的插件；单平台插件要么不出现，要么显示为禁用并带原因。
  - 对无插件名执行 `aw install -i` 且用户选择 `scope=project`、`platform=codex` 时，当前 catalog 下的 `git-commit` 不能作为可安装候选；如果没有其它满足 `hasRepoManagedArtifacts(plugin)` 的 Codex 插件，prompt 返回明确空态或只展示禁用项和原因。
  - 对显式插件名执行 `aw install git-commit -i --platform codex --scope project` 或等价交互路径时，runtime 在 dispatch 前返回可读业务错误，说明 `git-commit` 不包含 repo-managed artifacts；不能调用到 `installCommand()` / `CodexAdapter.installPlugin()` 后才失败。
  - fixture 中加入一个同时包含 repo-managed artifacts 的 Codex 插件后，`scope=project`、`platform=codex` 的交互式 `install` 只允许选择满足该条件的插件；同一 catalog 里的纯 native-only 插件仍被隐藏或禁用。
  - degraded ledger 下重复执行 `aw install <plugin> -i` 且目标已受管时，会补问 `skill-trigger`，并把选择作为 `requestedSkillTrigger` 传入普通命令调用。
  - degraded ledger 下显式执行 `aw upgrade <plugin> -i` 时，会补问 `skill-trigger`，并把选择作为 `requestedSkillTrigger` 传入普通命令调用。
  - degraded ledger 下的重复 install / 显式 upgrade 在 `CI=true`、`--no-interactive` 或非 TTY 中继续返回现有确定性错误，不进入 prompt。
  - degraded ledger 下 fake prompt 返回 skip、空值或非法 `skill-trigger` 时会被拒绝，不会隐式继承旧偏好。
  - 非 TTY 下 `install/uninstall/upgrade` 缺插件名不会挂起；`install/uninstall` 的退出码和 stderr 文案来自 CLI 业务错误，不是 Commander required argument 错误。
  - `--interactive` 在 TTY 下优先开启 prompt；`--no-interactive` 下即使 TTY 也不 prompt。
  - `CI=true` 下即使 TTY 且未传 `--no-interactive` 也不 prompt，并返回确定性错误或要求补齐参数；同时覆盖 `--interactive`、`--no-interactive`、`CI=true` 的优先级。

### Phase 5：输出、日志与 debug 系统

这一阶段不只修掉“不友好的 warning”，还要补齐正常成功路径的可见性。输出目标分三层：

- 默认输出：给普通用户看的执行摘要，简短但不沉默。
- verbose 输出：给会排查问题的用户看的关键决策，不需要翻日志文件。
- debug 日志：给维护者看的完整事件链，落盘、脱敏、可复现。

- [ ] 新增统一输出模型，替代命令结果里散落的 `output: string` / `warnings: string[]`：
  - `CommandNotice`：用于最终渲染给用户的消息。
  - `CommandEvent`：用于 verbose/debug 的结构化事件。
  - `OutputLevel = success | info | notice | warning | debug`。
  - `OutputTarget = stdout | stderr | debugLog`。
  - 每条消息携带可选 `platform/plugin/scope/action` 来源字段，避免继续解析 `[codex/git-commit]` 这种字符串前缀。
- [ ] 新增 CLI reporter/logger 模块，例如：
  - `packages/cli/src/output/reporter.ts`：负责 stdout/stderr 渲染、去重、排序和 TTY/非 TTY 差异。
  - `packages/cli/src/output/debug-log.ts`：负责 debug 文件创建、脱敏、轮转和最终日志路径提示。
  - `packages/cli/src/output/redact.ts`：统一隐藏 token、password、secret、key、authorization、cookie 等敏感字段。
- [ ] CLI flag 与环境变量：
  - `-v, --verbose`：stderr 输出关键决策和被降噪的诊断，不落完整日志文件。
  - `-D, --debug`：开启完整 debug log，并隐含 `--verbose`。
  - `--log-file <path>`：把 debug log 写到指定路径；未传时，写命令默认写到 `~/.aw/logs/aw-<timestamp>-<command>.log`，`status` 默认写到系统临时目录下的 `agent-workflows/aw-<timestamp>-status.log`。
  - `AW_DEBUG=1` 等价于 `--debug`，方便 CI 或用户复现问题。
  - `--quiet` 首版可以暂不引入；如果引入，只能压掉普通 info，不能隐藏 warning/error。
- [ ] 默认输出要覆盖 `install/uninstall/upgrade` 正常路径，而不是只在出错时说话：
  - 命令开始：`安装 git-commit：Codex / user scope`。
  - catalog：`使用内置插件目录` 或 `使用本地 marketplace：~/.aw`。
  - marketplace：`已同步本地 marketplace：~/.aw` / `本地 marketplace 已是最新`。
  - native：`已注册 Codex marketplace：~/.aw` / `Codex marketplace 已存在`。
  - plugin：`已启用 git-commit@aw`。
  - repo artifacts：`已写入项目配置：.codex/...`，只在确实写入时出现。
  - 结束：`完成。下一步：重新打开 Codex 会话或运行 aw status git-commit --platform codex 查看状态。`
- [ ] verbose 输出要记录“为什么这样做”：
  - normalized options：命令、插件名、platform、scope、cwd。
  - platform resolution：检测到哪些 adapter，`auto` 如何收敛。
  - catalog resolution：embedded/local 的选择原因、freshness metadata 是否命中。
  - marketplace repair decision：为什么需要或不需要 `codex plugin marketplace add`。
  - skill trigger decision：最终偏好来自显式参数、默认值还是既有 ledger。
  - drift 降噪说明：哪些 `driftWarnings` 没进默认输出，为什么只放到 verbose/debug。
- [ ] debug log 要完整记录一次命令的排查链路：
  - `runId`、时间戳、CLI 版本、Node 版本、平台、命令参数、cwd、AW_HOME、相关配置路径。
  - 每个主要步骤的开始/结束、耗时和结果。
  - 原生命令调用：command、args、cwd、exit code、duration、stdout/stderr 摘要；完整 stdout/stderr 可进入 debug log，但必须脱敏。
  - 文件写入计划与结果：目标路径、写入类型、是否 no-op；不记录完整文件内容，除非是短小且已脱敏的配置摘要。
  - rollback/degraded 标记原因。
  - 最终 notices、warnings、error stack 摘要。
- [ ] debug log 保留策略：
  - 写命令默认创建 `~/.aw/logs`，只保留最近 20 个或 14 天内日志，超过后清理旧文件。
  - `status` 默认 debug log 不创建 `~/.aw/logs`，只在系统临时目录下写本次诊断日志；临时目录清理失败不能影响 status。
  - 清理失败不能影响主命令，只在 debug log 里记录。
  - 失败时默认 stderr 提示实际日志路径；成功时只有 `--debug` 才提示日志路径。
- [ ] 把命令结果从单一 `warnings: string[]` 扩展为结构化 notices，或至少在 CLI 入口做分类渲染：
  - `info`：本地 marketplace 已初始化/复用。
  - `success`：已安装/卸载/升级哪些插件、平台和 scope。
  - `notice`：安装成功但有可见性条件，例如 Codex project scope 需要 repo trusted。
  - `warning`：需要用户处理的问题，例如 native command 失败、账本 degraded 阻止隐式继承。
  - `debug`：只在 `--verbose` 或 `aw status` 输出的漂移细节。
- [ ] 修改 install/uninstall/upgrade 后置 status warning 策略：
  - 默认不要把所有 `driftWarnings` 直接作为命令 warnings。
  - 只保留会影响本次安装是否可用的事项，并改写为面向用户的句子。
  - 例如当前 `当前 repo trust 状态未知，project scope 会话可见性无法确定。` 改成：
    - `Codex 已写入 project scope 文件，但当前仓库尚未确认 trusted；在 Codex 信任该仓库前，这些 project 配置可能不会进入会话。`
- [ ] 改造 `writeWarnings()`：
  - 中文默认输出用 `注意：` 或 `需要处理：`，不再硬编码英文 `Warning:`。
  - 去重后保留稳定顺序。
  - 对带 `[codex/git-commit]` 前缀的内部 warning，默认渲染为 `Codex / git-commit：...` 或直接改成结构化来源字段。
  - prepare / replay warning 的相对顺序是 CLI 合同，不只是展示细节；例如 degraded replay warning 必须先于后续 `upgrade --all` 阻断错误或显式 upgrade 继承失败错误输出。
  - warning 去重以一次 CLI 调用为边界；同一 prepare warning 不能因为 prepare 阶段和最终 reporter 各渲染一次而重复出现。
- [ ] 对 degraded / skill trigger 文案做专门翻译：
  - 当前：`[codex/git-commit] installed.json 处于 degraded 状态，跳过卸载后的 skill trigger 重选。`
  - 目标：`本机安装账本处于异常恢复状态，本次没有自动重选 git-commit 的 skill 触发偏好。执行 aw status git-commit --platform codex 查看详情；继续安装时请显式传 --skill-trigger default|manual|auto。`
- [ ] 输出成功状态：
  - `Installed git-commit on codex (scope=user).`
  - 中文可改为：`已安装 git-commit：Codex / user scope。`
  - 对 Codex native：`已注册本地 marketplace：~/.aw`、`已启用插件：git-commit@aw`。
- [ ] 增加测试：
  - 成功安装不出现英文 `Warning:`。
  - 成功安装包含 catalog、marketplace/native、plugin enabled 和完成摘要，避免正常路径过度沉默。
  - 成功卸载、升级也包含目标插件、platform、scope 和下一步摘要。
  - degraded warning 被渲染成用户能理解的中文。
  - `--verbose` 输出 normalized options、platform/catalog 选择和被降噪的 drift 诊断。
  - `--debug` 生成 debug log，并按输出模式提示日志路径；`status --json` 下日志路径只能写到 `stderr`，不能污染 JSON `stdout`。日志内容包含 native CLI stdout/stderr 摘要。
  - `aw status --debug` 未传 `--log-file` 时不创建 `~/.aw` 或 `~/.aw/logs`，日志路径位于系统临时目录；显式 `--log-file <path>` 只写用户指定文件，不触发其它 status 修复或同步。
  - debug log 会脱敏 `TOKEN`、`PASSWORD`、`SECRET`、`AUTHORIZATION` 等环境字段和命令输出。
  - 非 TTY 输出稳定、无 spinner 控制字符，便于测试和 CI 收集。
  - degraded replay warning 先于 `upgrade --all` 阻断错误输出。
  - degraded replay warning 先于显式插件 `upgrade` 的 skill-trigger 继承失败错误输出。
  - `init` / `install` entry flow 中的同一条 prepare warning 在一次命令里只出现一次。

### Phase 6：status 重新设计为日常状态面板

`install` 输出的是本次操作收据，`status` 应该回答“现在真实状态是什么”。它的价值在于跨命令、跨时间、跨 scope 重新读取当前机器和项目状态，发现漂移、外部修改、catalog 变化和可见性问题。

- [ ] 引入独立的 status options 与聚合模型：
  - 新增 `StatusCommandOptions`，包含 `cwd`、`scope?: Scope`、`platform?: 'codex' | 'claude' | 'both'`、`verbose?: boolean`、`json?: boolean`，其中 `scope/platform` 都是过滤条件。
  - `statusCommand()` 不再调用执行型命令的 `resolveTargetPlatforms()` 来处理默认路径；未传 `--platform` 时扫描可用平台和有证据的平台，未传 `--scope` 时扫描 user/project 两个 scope。
  - adapter 层 `PlatformAdapter.status(plugin, scope)` 可以先保持单 platform + scope 形状；status orchestrator 负责对矩阵逐格调用、捕获失败并聚合。
  - 新增聚合结果，例如 `StatusSummary` / `StatusMatrixReport`，保留每个 `platform + scope` 的原始 `StatusReport`，同时输出面向用户的 health、evidence 和 next steps。
- [ ] 明确 `aw status` 的只读合同：
  - `statusCommand()`、status orchestrator、Phase 3 discovery helper 和 status 默认路径不得调用 `ensureLocalMarketplace()`，也不得调用带 `ensureLocalMarketplace: true` 的 `preparePluginTargetsForCommand()` / `prepareCommandEnvironment()`。
  - status 可以读取 `~/.aw`、`installed.json`、tracking manifest、平台配置和 native 状态；缺失、损坏、版本漂移或 ledger degraded 都只能进入诊断结果，不能在读取前隐式重建或刷新。
  - 当 `~/.aw` 缺失、`config.json` stale 或本地 marketplace 布局不健康时，status/discovery 读取 current catalog 必须回退 embedded catalog，并把本地 marketplace 不健康的原因放进诊断；不得把 stale 本地 marketplace 当作 current catalog，也不得为了维持 current catalog 可读性而同步或修复 `~/.aw`。
  - status 不写 `~/.aw`、`installed.json`、tracking manifest、`.codex/config.toml`、`.claude/settings.json` 或任何平台原生配置。
  - `status --debug` 的隐式日志也遵守只读边界：未传 `--log-file` 时不得创建或清理 `~/.aw/logs`；显式 `--log-file` 是用户指定的诊断输出，只能写该路径，不能顺带初始化、同步或修复业务状态。
  - 如果本地 marketplace 缺失或损坏，status 给出 `aw init`、`aw install <plugin>` 或显式修复命令建议；真正修复留给 install/upgrade/init 等写命令。
- [ ] 重定义 `aw status` 默认行为：
  - `aw status` 不传插件名时，通过 Phase 3 discovery helper 列出 AW 管理过或当前平台能发现的插件摘要，而不是只输出底层字段或 current catalog 列表。
  - `aw status git-commit` 默认扫描相关 platform/scope 证据：Codex user native、Codex project artifacts、Claude user/project，以及 AW ledger/tracking；不要因为 `platform=auto` 在双平台下歧义就直接报错。
  - `--platform` / `--scope` 只作为过滤条件，不再是看见状态的前置条件。
  - 没有任何安装证据时，也要输出“未安装 / 未发现受管状态”，并给出安装命令建议。
  - 显式插件名如果不在当前 catalog，也先进入 historical placeholder + 证据扫描；只有需要执行修改的命令才把“当前 catalog 缺失”作为阻断条件。
- [ ] 默认 status 输出采用“摘要 + 明细 + 下一步”的结构：
  - 摘要：`git-commit：可用 / 需要处理 / 部分可用 / 未安装 / 状态未知`。
  - 明细：按 `platform + scope` 分组展示 3 到 5 个用户能理解的状态点。
  - 下一步：只给最可能的一条或两条命令，例如 `aw install git-commit --platform codex`、`aw upgrade git-commit`、`aw uninstall git-commit --platform claude --scope project`。
  - 默认不输出 `catalogCompatibility=current` 这类原始字段名，改成 `插件目录是当前版本` / `插件已从当前目录移除` / `插件能力已变化，需要显式升级`。
- [ ] status 默认要展示有用信息，而不是复述完整安装日志：
  - 当前是否能被平台加载：Codex marketplace 是否注册、插件是否 enabled、Claude marketplace/plugin 是否存在。
  - 当前是否由 AW 管理：ledger/tracking 是否可读，是否 degraded。
  - 当前 scope 是否有效：Codex project 是否受 repo trust 影响，Claude project/user 是否命中。
  - 当前本地 marketplace 是否健康：`~/.aw` 是否存在、是否和当前 CLI bundle 匹配。
  - 当前 skill trigger 偏好是否与 runtime 文件一致。
- [ ] 保留 skill-trigger 状态面的现有分支，不在 status 重写时压平：
  - 默认摘要只展示自然语言结论，例如“skill 触发偏好一致 / 存在漂移 / 无法判断”，不输出 raw `skillTriggerLedger=` 字段。
  - `--verbose` 展示现有诊断字段的等价信息：ledger 偏好、runtime 匹配结果、`matched` / `matches(default,auto)` / `mixed` / `unknown` / historical fallback、drift 判断和诊断原因。
  - `--json` 保留结构化字段：`skillTriggerPreference`、`skillTriggerRuntimeState`、`skillTriggerRuntimeMatches`、`skillTriggerDrift`、`skillTriggerDiagnostics[]`。
  - `mixed`、`drift`、`unknown`、historical fallback 不能被统一折叠成普通 `needsAttention`；health 可以汇总，但 verbose/json 必须能还原具体 skill-trigger 状态。
- [ ] status health model 结构化：
  - `ready`：当前证据完整，平台应该能加载。
  - `partial`：部分 scope/platform 可用，另一些有问题。
  - `needsAttention`：需要用户运行修复、升级、卸载或重新安装。
  - `external`：平台原生状态存在，但缺少 AW 管理账本，不能安全自动改。
  - `notInstalled`：没有发现安装证据。
  - `unknown`：无法可靠判断，例如账本 degraded、runtime 文件不可读、native 只读状态缺失。
- [ ] 对 Codex native marketplace 状态保留明确字段，但只在 `--verbose` 或 `--json` 展开：
  - `marketplaceRegistered=yes/no`
  - `marketplaceSource=<path>`
  - `marketplaceSourceType=local/missing/invalid`
  - `marketplaceRootResolution=localSource|installedCopy|missing|unknown`：local AW source 注册成功时标 `localSource`，不要要求 `.tmp/marketplaces/aw` 存在。
  - 默认摘要改成自然语言，例如 `Codex 已注册本地 marketplace：~/.aw`。
- [ ] 增加 `status` 输出模式：
  - 默认人类可读摘要。
  - `-v, --verbose` 展开 ledger、tracking、catalog、runtime drift、trust、native config 来源。
  - `-j, --json` 输出稳定 schema，方便脚本和测试；字段名可以保留 `catalogCompatibility`、`marketplaceRegistered` 等机器语义。
  - `-D, --debug` 记录 status 读取了哪些文件、哪些证据命中、哪些判断被标成 unknown。
  - `--json` 与 `--verbose` / `--debug` 可以叠加，但 `--json` 始终控制 `stdout` 为单一 JSON payload。`--verbose` 在 JSON 模式下只展开 JSON payload 的诊断字段，CLI 级 verbose 决策诊断写 `stderr`；`--debug` 隐含 verbose 并写 debug log，但不能向 `stdout` 追加日志路径、摘要或人类提示。
- [ ] 遇到常见异常时，status 给明确建议：
  - source 写成 manifest 文件：`运行 aw install <plugin> --platform codex 重新通过 Codex 原生命令注册 marketplace。`
  - ledger degraded：`本机安装账本处于异常恢复状态；先运行 aw status <plugin> --verbose 查看详情，修复前请显式传 --skill-trigger。`
  - catalog missing：`当前版本已不再包含该插件；如需清理，运行 aw uninstall <plugin> --platform ...。`
  - capability changed：`插件能力已变化；运行 aw upgrade <plugin> 进入受控升级。`
- [ ] 增加 status 测试：
  - `aw status` 无参数能列出受管插件摘要。
  - `aw status git-commit` 不传 `--platform/--scope` 时能展示 Codex user 和 project 证据。
  - `aw status` 无参数从 repo 子目录运行时，仍能列出 repo root 的 Codex project scope 受管插件摘要。
  - `aw status git-commit` 从 repo 子目录运行且不传 `--platform/--scope` 时，仍能展示 repo root 的 Codex project artifacts、tracking manifest 和 project ledger 证据。
  - `aw status` 从 repo 子目录运行时，Claude project scope 仍只读取该子目录 `.claude/` 与对应 project key；不能把 repo root `.claude/` 或兄弟子目录 `.claude/` 误合并进当前结果。
  - 无安装证据时输出未安装和安装建议，不空白、不报平台歧义。
  - 显式 `aw status <unknown-plugin>` 即使当前 catalog 没有该插件、ledger/tracking/native 也没有证据，也不能再抛 `Unknown plugin`；默认输出应是“未安装 / 未发现受管状态”并给安装建议，`--json` 输出 `health=notInstalled` 或等价稳定字段。
  - 同步迁移现有 `packages/cli/tests/integration/cli.test.ts` 里的 unknown plugin 回归：`installCommand(['legacy-plugin'])` 仍保持 `Unknown plugin` 错误；`statusCommand(['legacy-plugin'])` 的“无证据”分支改断言 not installed，而 historical/native evidence fallback 分支继续单独断言能解析为 Codex 状态。
  - current catalog 已删除但 ledger/tracking/native 仍有证据时，默认 status 仍列出该历史插件，并标注当前插件目录缺失。
  - 单个平台不可用、单个 scope 读取失败或某侧只能返回 `unknown` 时，整体 health 不能被误判成 `notInstalled`。
  - `--scope user` / `--scope project` 只过滤明细矩阵，不改变未传 scope 时的跨 scope 默认扫描语义。
  - 默认输出不出现 raw `catalogCompatibility=`、`scopeInitialized=`、`driftWarnings=`。
  - `--verbose` 展开完整诊断字段。
  - `--json` 输出稳定 schema，覆盖 ready/partial/needsAttention/external/notInstalled/unknown。
  - `aw status -j` 的 `stdout` 是纯 JSON，不混入人类摘要、warning 前缀或 debug log 路径。
  - `aw status -j --verbose` 的 `stdout` 仍是纯 JSON，verbose 状态细节进入 JSON 稳定字段；如有 reporter 诊断，只能写到 `stderr`。
  - `aw status -j --debug` 与 `aw status -j --verbose --debug` 同样保持 `stdout` 纯 JSON，debug log 路径和完整诊断只写 `stderr` 或 debug log。
  - skill-trigger 既有状态矩阵继续覆盖：matched、equivalent defaults / `matches(default,auto)`、mixed、drift、unknown、historical fallback。
  - stale marketplace、local marketplace 布局损坏、degraded ledger、runtime skill 文件缺失或损坏时，除了 health 结果，还要断言 `--verbose` / `--json` 中的 skill-trigger 诊断没有丢。
  - 默认输出、`--verbose`、`--json` 三个视图分别断言 skill-trigger 字段落位：默认不出现 raw 字段名，verbose 可读展开，json 保留稳定机器字段。
  - 常见异常能给出一条可复制修复命令。
  - `~/.aw` 缺失、marketplace 损坏或 ledger degraded 时，`aw status` 能输出诊断和修复建议，但不会创建/修改 `~/.aw`。
  - stale `~/.aw/config.json` 下，`aw status <plugin>` 仍能通过 embedded catalog 成功解析当前插件状态，且不会创建 `~/.aw/plugins/<plugin>`、改写 `config.json` 或触发本地 marketplace repair。
  - 同一 stale 场景下，`--verbose` / `--json` 要能看出 catalog resolution 为 `source=embedded`，并保留“本地 marketplace 缺失、stale 或不健康”的原因，避免把 stale 本地目录误判为 current catalog。
  - `~/.aw` 缺失时运行 `aw status --debug` 也不会创建 `~/.aw`；默认 debug log 写入临时目录，显式 `--log-file` 只写指定路径。
  - 读取 status 不会改写 `installed.json`、tracking manifest 或平台配置；测试用文件存在性、mtime 或内容快照钉住这条边界。

### Phase 7：文档与验收

- [ ] 更新 `README.md` 快速使用：
  - 推荐 `aw install git-commit` 或 `aw install` 交互式。
  - 展示常用短选项示例，例如 `aw install git-commit -p codex -s user`。
  - 示例默认不再写 `--scope project`。
- [ ] 更新 `docs/plugin-installation.md`：
  - `install/uninstall/upgrade` 默认 scope 改为 user，并说明 `status --scope` 是过滤条件、未传时会跨 scope 扫描。
  - 新增短选项对照表。
  - 新增 `install/uninstall/upgrade` 交互式模式说明，并明确插件名通过列表选择，不手动输入。
  - Codex native marketplace 说明改为“通过 `codex plugin marketplace add ~/.aw` 校验并注册 local source”，而不是“CLI 直接写 config”；同时说明 local source 不会被复制成 `.tmp/marketplaces/aw` 副本。
  - 保留 Codex `project` scope 只影响 repo-managed artifacts 的说明。
- [ ] 更新 `docs/architecture.md`：
  - Codex adapter native CLI 边界。
  - 命令 reporter、notices/warnings 分层、debug log 边界。
- [ ] 更新 `docs/testing.md`：
  - 增加交互式 fake prompt 测试约定，覆盖候选列表选择和非法候选拒绝。
  - 增加交互式 `install` 的平台兼容性和可安装性测试约定，覆盖 `marketplace.policy.products` 过滤、`both` 下单平台插件禁用、显式多插件名的共同兼容平台交集、无共同兼容平台时的 runtime 早失败，以及 fake prompt 返回不兼容平台时的拒绝；同时覆盖 `Codex + project scope` 下 `hasRepoManagedArtifacts(plugin)` 的候选过滤、空态、显式插件名早失败和正向可选插件。
  - 增加 degraded ledger 下交互式 `skill-trigger` 补问测试约定，覆盖重复 install、显式 upgrade、非交互确定性错误和非法 prompt 返回值。
  - 增加 Codex native runner fake 测试约定，并说明 CLI entry integration 优先通过 `CliRuntimeOptions` 注入 fake runner / adapters，不依赖真实 `codex` 可执行文件。
  - 增加 repo 子目录运行的回归测试约定，要求 discovery、status、交互式 `uninstall/upgrade` 分别验证 Codex project scope 证据锚定 repo root、Claude project scope 证据锚定调用目录 realpath。
  - 增加 historical placeholder 回归测试约定，要求 Codex ledger-only 的 `hasRepoManagedArtifacts: true` 不恢复 hook / instruction / permission / agent 等具体 kind；discovery、默认 status、交互式 `uninstall/upgrade` 候选都必须覆盖这条边界，并覆盖 tracking 明确记录 `kind: "hook"` 时才能恢复 hook 能力的正向路径。
  - 增加 status skill-trigger 状态矩阵约定，要求 matched、equivalent defaults、mixed、drift、unknown、historical fallback 在默认/verbose/json 视图都有覆盖。
  - 增加 status JSON 通道测试约定，要求 `aw status -j`、`aw status -j --verbose`、`aw status -j --debug`、`aw status -j --verbose --debug` 的 `stdout` 均为纯 JSON，verbose/debug 人类诊断只能进入 `stderr` 或 debug log。
  - 增加 runtime env 贯穿测试约定，要求 direct command 与 `runCli(..., { env })` 两条入口都覆盖平台检测、ledger/current catalog 解析、home 路径、默认 adapter 创建和 discovery/status 读取路径，防止新 helper 回落到 `process.env`。
  - 增加 stale 本地 marketplace 的 status 回归测试约定，要求 stale `~/.aw/config.json` 下 status 只读回退 embedded catalog，`--verbose` / `--json` 能暴露 `source=embedded` 与本地目录不可用原因，并断言不会创建插件目录或修复 `~/.aw`。
  - 增加 reporter/debug log snapshot 测试约定，确保默认输出稳定、debug 输出可脱敏；同时覆盖 prepare / replay warning 先于 terminal error 输出，以及同一 prepare warning 在一次命令中只渲染一次。
  - 增加 `--skill-trigger` CLI entry 回归测试约定，覆盖显式 `install`、显式插件 `upgrade` 的 `manual|auto|default` 正向透传，以及 `upgrade --all --skill-trigger` / `upgrade -a -t` 的入口层确定性拒绝。

## 实施期注意点

- `codex plugin marketplace add` 的本轮实现合同已经用 `/Users/LeslieChan/Desktop/codex/codex-rs` 源码核过：local AW_HOME source 走 `codex plugin marketplace add <canonical AW_HOME>`，不带额外 flag。实施时如果本机已安装的 `codex` binary 和该源码不是同一版本，可以再跑一次 `codex plugin marketplace add --help` 做人工确认，但测试里的 fake runner 应先固定当前源码合同。
- Codex local source 注册后只写 user config 并把 `installed_root` 指回 canonical source 目录，不会生成 `.tmp/marketplaces/aw`。adapter status、status health 和测试都要围绕 `[marketplaces.aw].source_type = "local"` 与 canonical `source` 判断健康，不要用 copied install root 是否存在来判断。
- 当前上游 CLI 没有 `codex plugin install <plugin>@aw` 子命令。这一轮只把 marketplace 注册交给 native CLI，插件 enabled 仍由 AW 写 `[plugins."<plugin>@aw"] enabled = true`；不要在实现中临时引入不可执行的 native install 分支。
- `status <unknown-plugin>` 是明确的产品行为变更：执行型命令仍应对 catalog miss 报 `Unknown plugin`，但 status 要改成“未安装 / 未发现受管状态”。实施时先拆旧测试，避免把有意变化当成回归。
- 这份 review 没有新的 blocking finding；实施顺序仍以 Phase 0 的 runtime 注入链为先。后面的 native runner、prompt、reporter、debug logger、discovery 和 status 都从同一条 context 走线接入，能减少后续返工。

## 验收标准

- `aw install git-commit --platform codex` 在未传 `--scope` 时安装到 `user` scope。
- 常用短选项可用且行为等价于长选项，例如 `-s/--scope`、`-p/--platform`、`-t/--skill-trigger`、`-i/--interactive`、`-a/--all`、`-v/--verbose`、`-D/--debug`、`-j/--json`、`-f/--force`。
- `--skill-trigger` 继续只作用于显式 `install` 和显式插件 `upgrade`，并真实影响最终 runtime/materialization 结果；`upgrade --all --skill-trigger` 与 `upgrade -a -t` 继续在入口层返回确定性错误。
- Codex native 插件安装会调用 `codex plugin marketplace add <canonical AW_HOME>`，不再只靠直接写 config 完成 marketplace 注册。
- `runCli()` / `buildProgram()` 可以在测试中注入 fake native runner 或 fake adapters；`AW_FORCE_CODEX_AVAILABLE=1` 且 `PATH=''` 的 CLI entry 用例不会因为 Codex native add 接入而调用真实二进制。
- CLI / command 运行时能力只通过统一 `CommandExecutionContext` 透传；native runner、prompt、reporter、debug logger 不再分别在多个 phase 里各自加入口。
- `CommandExecutionContext.env` 贯穿 CLI entry、direct command、discovery、status、默认 adapter、平台检测、home 路径和 current catalog 解析；测试注入 env 后不会有任一路径回落到 `process.env`。
- Codex native add invocation 固定为 `codex plugin marketplace add <canonical AW_HOME>`；local source 不传 `--ref`、`--sparse` 或其它未确认 flag，也不把 `.agents/plugins/marketplace.json` 当作 source。
- `~/.codex/config.toml` 里的 `[marketplaces.aw]` 最终仍满足：
  - `source_type = "local"`
  - `source = "<canonical ~/.aw>"`
  - `source` 不是 `.agents/plugins/marketplace.json`。
- 不完整 options 不再产生 `Cannot read properties of undefined (...)`，而是走默认值或返回明确错误。
- TTY 下 `aw install`、`aw uninstall`、`aw upgrade` 可以通过交互完成插件名、平台和可选偏好选择；非 TTY 下不会阻塞。
- `aw install` / `aw uninstall` 无插件名时不会在 Commander parse 阶段失败；交互路径能进入 prompt，非交互路径返回 CLI 业务错误和示例。
- `CI=true` 或 `--no-interactive` 下不会进入 prompt。
- 交互式插件名来自候选列表：安装不能选择 catalog 之外的插件，卸载不能选择不可发现的目标，升级不能选择既不是受管安装记录、也不在本次可处理候选中的任意字符串。
- 交互式 `install` 在 prompt 层约束 `marketplace.policy.products`：平台先锁定，catalog 候选按目标平台过滤或禁用；单平台插件不能被选择到不兼容平台或 `both`，不把兼容性错误留到命令深层才暴露。
- 交互式 `install` 的显式多插件名路径不自动拆分命令；整组插件必须拥有共同兼容平台集合，且用户选择的平台必须完全落在该集合内。无共同集合或 fake prompt 返回不兼容平台时，runtime 在调用普通命令 API 前返回可读错误。
- 交互式 `install` 在 prompt 层同时约束 `scope + platform + capability`：`Codex + project scope` 只允许选择包含 repo-managed artifacts 的插件。当前 catalog 下，`git-commit` 不能被当成 `codex + project` 的可安装候选；显式选择这组目标时会在调用普通命令 API 前早失败。
- degraded ledger 下需要显式 `skill-trigger` 的重复 `install` 和显式插件 `upgrade`，在 TTY 交互模式下会先补问 `skill-trigger` 再 dispatch；非交互、`CI=true` 或 `--no-interactive` 继续返回确定性错误。
- current catalog 已删除但 ledger/tracking/native 仍有 AW 管理证据的插件，仍能出现在 `aw status` 摘要和交互式 `uninstall` 候选里。
- historical placeholder 按 `platform + scope` 分格生成和消费；默认 `aw status <plugin>` 不会把 project-only 证据误报成 user scope，也不会把 user/project 的能力合成一份模糊状态。
- Codex historical placeholder 不凭 `CodexCapabilitySnapshot.hasRepoManagedArtifacts` 单独恢复 hook / instruction / permission / agent 等具体 repo-managed kind；只有 tracking artifact kind 或 hook identities 等明确证据存在时，discovery、status、交互式 `uninstall/upgrade` 才能把历史目标恢复成对应能力，否则必须给出 `unknown`、禁用态或等价保守结论。
- `upgrade --all` 保持 fail-fast 合同：混合 safe/blocked 候选时整体失败且不写入；交互式“全部可升级”复用同一 preflight，安全子集只能通过显式勾选插件执行。
- 默认成功路径不输出 `Warning: [codex/git-commit] ...` 这类内部诊断格式。
- prepare / replay warning 保留发生顺序，必须先于后续 terminal error 输出；同一 prepare warning 在一次 CLI 调用中只渲染一次。
- 默认成功路径会说明 catalog、marketplace/native 注册、插件启用和下一步，不再只有一行或几乎无输出。
- `--verbose` 能看到 options normalization、platform/catalog 选择、marketplace 修复判断和被降噪的 drift 诊断。
- `--debug` 或 `AW_DEBUG=1` 会生成脱敏 debug log 并隐含 `--verbose`；`--log-file <path>` 能控制日志路径，失败时 stderr 会给出日志路径。
- `aw status --debug` 未传 `--log-file` 时默认日志落在系统临时目录，不创建或清理 `~/.aw/logs`；显式 `--log-file` 只写用户指定路径。
- `aw status` 不传完整 `--platform/--scope` 也能跨 platform/scope 展示当前插件健康状态和下一步建议；`--scope` / `--platform` 只过滤结果，不再决定默认扫描范围；`--verbose` / `--json` / `--debug` 才展示完整 drift / ledger / trust 诊断。
- `aw status <unknown-plugin>` 在 catalog、ledger、tracking 和 native config 都没有证据时不再报 `Unknown plugin`；默认输出“未安装 / 未发现受管状态”并给安装建议，JSON 输出稳定的 `notInstalled` 状态。`aw install <unknown-plugin>` 仍保持明确的 `Unknown plugin` 错误。
- `aw status -j`、`aw status -j --verbose`、`aw status -j --debug`、`aw status -j --verbose --debug` 的 `stdout` 都是可直接 `JSON.parse` 的纯 JSON；人类诊断、日志路径和 verbose/debug 文案只进入 `stderr` 或 debug log。
- `aw status`、discovery 候选构建、交互式 `uninstall/upgrade` 从 repo 子目录运行时，Codex project scope 证据仍锚定 repo root；Claude project scope 继续以调用目录 realpath 为 key，不会把 repo root、子目录和兄弟子目录的 Claude project 安装错误合并。
- 交互式 `uninstall/upgrade` 在同名插件跨 platform/scope 共存时保留 candidate 身份；用户选择其中一格只处理该格，disabledReason 不会按插件名污染其它格子。
- `status` 重写后继续覆盖 skill-trigger 状态矩阵；matched、equivalent defaults、mixed、drift、unknown、historical fallback 在默认摘要、`--verbose` 和 `--json` 中各有明确落位。
- `aw status` 是只读命令：不会为了读取状态而同步、重建或修复 `~/.aw`，也不会改写账本、tracking 或平台配置。
- stale `~/.aw` 下 `aw status` 仍能回退 embedded catalog 读取 current catalog 状态，并在 verbose/json 诊断里说明本地 marketplace 不健康原因，同时保持完全只读。
- Codex native add 的失败提示覆盖 `stderr`、空输出、timeout、`ENOENT` / PATH 异常；默认错误对用户可读，`--debug` 保留原始 invocation 和 exit/cause 细节。
- 相关单元、集成、CLI 入口测试全部更新并通过：
  - `pnpm test:unit`
  - `pnpm test:integration`
  - 至少一次 `pnpm test:smoke:build` 验证真实 bundle 不受影响。

## 风险与注意点

- Codex native CLI 的实际子命令和 flags 已按 `/Users/LeslieChan/Desktop/codex/codex-rs` 当前源码确认：`codex plugin marketplace add <dir>` 是正确命令；local source 不带 `--ref` / `--sparse`。如果实施机器上的 `codex` binary 版本和该源码不同，再用 `codex plugin marketplace add --help` 做一次人工复核，但不要在未确认的情况下引入 `codex plugin install`。
- 短选项一旦发布就很难改；本计划选择让 `-p` 表示 platform、`-s` 表示 scope、`-D` 表示 debug、`-f` 表示 force，后续新增选项不要复用这些含义。
- Codex native marketplace 是 user-only，而 `project` scope 仍只代表 repo-managed artifacts；改默认 scope 为 user 后，要避免误删现有 project 语义和测试覆盖。交互式 install 的候选逻辑不能只按平台过滤，必须把 `Codex + project scope` 下的 `hasRepoManagedArtifacts(plugin)` 可安装性也纳入 prompt 合同，否则会把真实不可安装目标暴露给用户。
- Codex local marketplace add 只注册 local source，不产生 `.tmp/marketplaces/aw` 物化副本；status 和测试不能用副本是否存在判断 local source 是否健康。
- `status` 不能复用执行型 options 默认值，否则会再次丢掉“用户未传 scope/platform”的信息；实现时要把 `StatusCommandOptions` 和普通 `CommandOptions` 分开。
- `status` 不能复用会写入的准备 helper；凡是带 `ensureLocalMarketplace: true` 的路径都属于 install/upgrade/init 等写命令，不属于 status/discovery 默认读取路径。
- 交互式模式只能存在于 CLI entry 层；底层 command functions 要保持可脚本化、可测试。
- 交互式插件列表的候选来源要按命令区分：安装看 catalog，卸载看已安装或可发现状态，升级看已安装和 catalog 兼容性；候选读取失败时要给明确错误，不能退回自由输入。
- discovery helper 要能容忍部分证据读取失败；单个平台或单个 scope 的异常只能降级为 `unknown`，不能让默认 status 或候选列表整体失败。
- discovery helper 的 project identity 必须按平台分开：Codex project 解析 repo root，Claude project 使用调用目录 realpath；实现时不能为了复用 repo 子目录测试把 Claude 的子目录隔离语义改掉。
- historical placeholder 如果跨 scope/platform 合并，会污染 status 判断；实现时宁可多生成几个格子 target，也不要把 adapter 需要的 manifest 做成 union。
- `upgrade --all` 首版沿用 fail-fast 是为了保持现有命令合同和测试稳定；如果未来要改成 safe-subset，需要作为单独行为变更同时更新交互式、非交互、文档和回归测试。
- 直接把所有 `driftWarnings` 降噪可能隐藏真实问题；需要保留 `--verbose` 或 `aw status` 的完整诊断出口。
- debug log 可能把路径、命令输出和配置摘要长期留在本机；必须默认脱敏，并让日志轮转失败不影响主命令。`status` 的默认 debug log 不能写入 `~/.aw`，否则会破坏只读合同。
- 默认输出补足可见性时要克制，不能变成滚屏日志；详细原因放到 `--verbose`，完整链路放到 `--debug`。
- `aw status` 如果默认扫描全部平台和 scope，必须避免误把“平台当前不可用”判断成“插件未安装”；扫描失败要降级为 `unknown` 并说明原因。
- `aw status <unknown-plugin>` 的语义会从“catalog miss 错误”改为“未安装状态”。这会影响现有 unknown plugin 回归测试，尤其是 `packages/cli/tests/integration/cli.test.ts` 中同时覆盖 install miss 与 status fallback 的用例；实施时要把执行型命令错误和 status no-evidence 状态拆开断言。
- `status` 的默认摘要不能只是安装命令输出的复刻；它要重新读真实状态，重点展示健康、漂移和修复建议。
- `installed.json` degraded 语义涉及 skill trigger replay 和 sibling re-election，文案可以友好化，但行为边界不要放松。
