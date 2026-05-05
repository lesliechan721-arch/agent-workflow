# `aw` 交互控制台与安装输出重设计执行计划

日期：2026-05-05
来源：[`../specs/aw-interactive-console-ux.md`](../specs/aw-interactive-console-ux.md)
状态：待执行

## 需求来源

本计划落实 `docs/dev/specs/aw-interactive-console-ux.md`。如果实现过程中发现本计划和 spec 不一致，先回到 spec 校准需求，再更新计划；不要让实现按过期计划继续推进。

本轮改造的主线是：

- `aw` 主命令成为唯一交互入口，进入方向键驱动的插件控制台。
- `install` / `uninstall` / `upgrade` / `config` 子命令只服务非交互脚本调用。
- 默认人类输出和 TUI 只展示用户能理解、能行动的信息。
- 诊断细节保留在 `--verbose`、`--debug` 和 JSON 输出中。
- JSON receipt 覆盖所有脚本化子命令，`--json` stdout 必须是单一可解析 JSON。
- Codex native recovery、active cache、dynamic artifact refresh、project trust 和 session visibility 必须映射进统一的友好状态投影。

## 首版交付目标

首版要交付五层能力。

第一层是交互入口：

- 直接运行 `aw` 时，在 TTY 环境进入插件控制台。
- 非 TTY、CI 或 stdin/stdout 不支持交互时，主入口确定性失败，给出 `aw status`、`aw install <plugin> --platform codex --scope user` 等可复制命令示例，并提示机器可读输出使用 `--json`。
- 默认 prompt 实现使用 `@inquirer/prompts`，支持方向键、回车、返回、确认、文本输入和隐藏输入。
- 真实 TUI 之外保留可注入 prompt/console driver，测试不依赖真实终端。

第二层是友好状态投影：

- 在现有 discovery、status matrix、tracking、native state 和 artifact health 之上新增统一投影层。
- TUI、默认 `aw status` 和 `status --json.consoleItems` 复用同一套 `PluginConsoleItem` / `PluginConsoleLocation` / `PluginConsoleAction`。
- 首屏状态只使用 `未安装`、`已安装`、`可升级`、`需要处理`、`部分可用`、`由其它来源管理` 六类。
- 所有复杂底层状态通过稳定友好原因码表达，不把 `ledger`、`healthSource`、`artifactRefresh`、`sessionVisibility`、`projectTrust` 等内部词泄露给默认人类输出。

第三层是脚本化命令合同：

- 删除 `install/uninstall/upgrade` 的 `-i/--interactive`、`--no-interactive`。
- 删除 `config configure`。
- 删除 `config reset` 的 `-i/--interactive`、`--no-interactive`。
- 子命令缺必要参数时直接失败，并提示运行 `aw` 或对应非交互命令。
- 缺 required config 时，子命令失败并提示 `aw config set ...` 或 `aw` 主入口，不再 prompt。
- `config set` / `unset` / `reset --yes` 继续作为脚本化配置写入口，并保留 dynamic artifact refresh 语义。

第四层是输出合同：

- 写命令默认输出短句，例如 `git-commit 已安装到 Codex（个人）。`
- 当前项目安装可以展示用户能理解的项目文件摘要，但不展示 marketplace、app-server、RPC、cache、recovery breadcrumb、repo-managed、账本或 healthSource。
- warning 分成用户可行动 warning 和内部诊断 warning；默认输出只显示前者。
- `--json` stdout 不混入 prompt、warning、verbose 或 debug log 文案。
- `status --json` 保持现有 `StatusMatrixReport` 顶层兼容，只追加 `ok`、`command`、`friendlySummaries`、`consoleItems` 等兼容字段。

第五层是配置向导与 refresh：

- TUI 配置表单按 manifest config schema 生成，多字段一次提交。
- 抽出共享配置写入 helper，供 `config set`、`config unset`、`config reset --yes` 和 TUI 配置向导复用。
- TUI 保存前整体校验，成功后一次 patch 目标 store，并只触发一次 artifact refresh。
- 配置向导提交模型必须能区分 `updatedKeys` 和 `removedKeys`；可选字段已有值时，用户能在同一轮表单里显式清空。
- `artifactRefresh.triggerKeys` 必须和本轮 `updatedKeys + removedKeys` 对齐，描述同一次配置提交。
- `artifactRefreshFailed` 的 `重新应用配置` 是独立动作，只重跑 tracked refresh keys，不修改 config store。
- `config reset --yes` 保留 manifest-optional raw-store 清理分支，current catalog 缺失且插件名通过安全路径片段校验时仍可删除残留配置。

## 执行边界

本轮覆盖：

- `aw` 主入口 TUI。
- `install` / `uninstall` / `upgrade` / `init` / `config` / `status` 的 JSON receipt 与默认输出合同。
- `status` 友好摘要、`status --json.consoleItems`、`status --verbose` 诊断分层。
- Codex user native enabled config / active cache / recovery 的友好状态映射。
- dynamic artifact health、last refresh、refresh failed、project trust、session visibility 的友好状态映射。
- 配置向导、共享配置写入 helper、配置触发 refresh、重新应用配置 refresh 动作。
- 删除旧交互 flag、`config configure` 和相关文档。
- README、公开 docs、开发 docs、插件作者技能和示例同步。

本轮不覆盖：

- 批量安装、批量卸载或多选批量升级。
- TUI 内完整诊断矩阵。
- 新增远程 marketplace 浏览能力。
- 改变 manifest/schema/scope 的底层语义。
- 改变 native marketplace、native recovery breadcrumb、ledger、tracking 或 dynamic artifact 持久化格式。
- 新增无归属 Codex native residue 的 AW force cleanup 命令。

## 总体方案

### 友好状态投影层

新增模块，建议路径为 `packages/cli/src/commands/console-model.ts` 或 `packages/cli/src/commands/friendly-status.ts`。

职责：

- 从 `StatusMatrixReport`、discovery candidate、current catalog、native state、tracking 和 artifact diagnostics 生成 `PluginConsoleItem[]`。
- 集中定义 `PluginConsoleReasonCode`、状态优先级、位置摘要、动作合同和用户可读说明。
- 产物同时服务 TUI 首屏、详情页、默认 `aw status` 和 `status --json.consoleItems`。
- 保留底层 `StatusMatrixReport` 给 `--verbose`、debug log、现有 JSON 调用方和测试。

首版原因码必须覆盖：

- `nativeIncomplete`
- `nativeResidue`
- `missingRecord`
- `upgradeEvidenceUnknown`
- `artifactRefreshFailed`
- `artifactDrift`
- `projectVisibilityBlocked`
- `sessionVisibilityLimited`
- `externalOwnership`
- `requiredConfigMissing`
- `invalidConfig`
- `unreadableConfig`
- `trackingIdentityBroken`
- `roleOrMcpConflict`
- `unmanagedArtifactConflict`
- `catalogCapabilityChanged`
- `catalogUnavailable`

状态优先级必须集中在投影层：

- 外部来源和 AW 可管理证据冲突优先映射为 `needsAction`。
- tracking identity、native recovery、配置不可读、role/MCP 冲突、catalog capability changed 等阻断问题映射为 `needsAction`。
- dynamic artifact refresh failed、drift、missing 和配置缺失映射为 `needsAction`。
- project trust 或 session visibility 只影响当前会话可见性时映射为 `partial`。
- 只有完整受管证据健康且 current catalog 能证明版本或 bundle 不一致时，才显示 `upgradeAvailable`。
- 只有外部来源且没有 AW 证据时，显示 `external`。
- 只有 current catalog 且无安装证据时，显示 `notInstalled`。

升级判定必须保守：

- current catalog 不可读时，不显示 `可升级`。
- 无法确认已安装 `resolvedVersion`、安装快照版本或 bundle fingerprint 时，不显示 `可升级`，改为 `needsAction + upgradeEvidenceUnknown`。
- Codex native recovery、enabled-only、cache-only、artifact drift、refresh failed、外部 ownership 冲突、tracking identity 损坏等问题优先级都高于 `可升级`。

### TUI 控制器

新增主入口控制器，建议路径为 `packages/cli/src/commands/console.ts`。

职责：

- 加载 console items。
- 渲染插件首屏列表。
- 渲染插件详情页和 location-level 动作。
- 调用 prompt adapter。
- 把用户选择转换为现有非交互命令 API 调用。
- 在破坏性动作前二次确认。
- 处理返回、取消和错误说明。

控制器不能：

- 绕过 `installCommand` / `upgradeCommand` / `uninstallCommand` 的安全预检。
- 在 adapter 层直接 prompt。
- 在安全预检失败后继续打开配置表单。
- 把 `多个位置` 摘要当成隐式批量写动作。
- 给无归属 `nativeResidue` 生成自动 cleanup 动作。

安装/升级向导顺序固定为：

1. 选择插件、平台、位置和必要触发方式；只有插件确实需要且允许覆盖 skill trigger 时才展示触发方式，文案固定为 `默认`、`手动`、`自动`。
2. 执行不会写状态的安全预检，包括 Codex project safety、Codex config 可读性、external ownership、tracking identity、role/MCP 冲突和未受管项目文件冲突。
3. 安全预检全部通过后，才展示 required config 表单。
4. mixed target 安装/升级只提示一次 required config，并让后续 Codex / Claude 写入复用重新解析后的 effective config。
5. 调用非交互 command API 完成写入。

不可安装组合或需要改选目标的情况，必须在向导决策模型里给出友好原因，不进入配置表单，也不写任何状态。首版至少覆盖：

- 插件能力不支持当前项目位置时，提示改为安装到个人位置。
- Codex native 当前不可用但 Codex project 写入可行时，不把当前项目候选隐藏，只说明会写入项目文件。
- 外部来源或同名 ownership 冲突时，提示先处理冲突，不自动接管。

### Prompt 抽象

扩展 `packages/cli/src/commands/runtime.ts` 中的 prompt 抽象，或新增独立 `commands/prompt.ts`。

至少提供：

- `select`
- `confirm`
- `input`
- `password`
- 可滚动列表
- 返回/取消结果

默认实现使用 `@inquirer/prompts`。`createReadlinePrompt()` 可以删除，或仅作为测试辅助保留，但子命令不再调用旧编号输入式 prompt。

依赖落地前需要用项目实际 registry 验证：

- `@inquirer/prompts` 可安装。
- `pnpm build` 后打包产物包含运行所需依赖。
- smoke test 使用的 tarball 不缺依赖。

### 配置写入 helper

新增共享 helper，建议路径为 `packages/cli/src/commands/config-write.ts` 或 `packages/cli/src/utils/plugin-config-write.ts`。

职责：

- schema-aware 写入：服务 `config set`、`config unset` 和 TUI 配置向导。
- raw-store reset：服务 `config reset --yes` 的 manifest-optional 清理分支。
- raw-store reset 必须先复用 `assertSafePluginConfigSegment()` 或等价校验，拒绝空字符串、路径穿越、绝对路径和协议前缀等非法插件名。
- 多字段一次校验和一次 patch。
- 多字段提交模型同时表达更新和删除：输入包含 `updates` 和 `removeKeys`，或等价内部模型；receipt 返回 `updatedKeys` 和 `removedKeys`。
- 可选字段已有值时，TUI 配置向导必须提供显式清空路径；清空后的 key 进入 `removedKeys`，不能被当成保留旧值或写入空字符串。
- `artifactRefresh.triggerKeys` 必须从本轮 `updatedKeys + removedKeys` 得出，确保只更新、只删除、更新和删除混合提交都对应同一轮 refresh。
- 保留 unknown keys，不复制另一层 effective config。
- sensitive 值不在输出、debug log 或 receipt 明文出现。
- 写入成功后调用 `refreshArtifactsAfterConfigWrite()`，并返回稳定 `artifactRefresh` receipt。
- refresh 失败时保留 config store，不回滚，不执行第二条隐藏 refresh 路径。

新增 refresh-only helper：

- 服务 `reapplyConfigRefresh` 动作。
- 不修改 config store。
- 基于 tracking 中失败 artifact 的 `refreshKeys`，或当前目标全部 tracked refresh keys，重跑 dynamic artifact refresh。
- 找不到可定位 tracked dynamic artifact 时返回 `skipped`。
- 必须复用 `refreshArtifactsAfterConfigWrite()` 或等价覆盖同一条 artifact apply / tracking 写回路径，不能只运行 renderer 并返回 receipt。
- 刷新成功时更新对应 artifact 的 `lastRefresh` 和 tracking 诊断；刷新失败时保留配置，并把本次失败写入 receipt 的 `artifactRefresh.error` 和后续 `status` 可读取的 tracking 诊断。

### JSON receipt 与输出分层

调整 `packages/cli/src/index.ts` 中的输出边界，必要时把 receipt rendering 拆到 `packages/cli/src/output/command-receipt.ts`。

写命令最小公共结构：

```json
{
  "ok": true,
  "command": "install",
  "warnings": [],
  "nextSteps": []
}
```

写命令还要按命令补齐：

- `plugins`
- `targets`
- `actions`
- `skipped`
- `artifacts`
- `native`
- `artifactRefresh`

`status --json` 仍以当前矩阵字段为顶层：

```json
{
  "ok": true,
  "command": "status",
  "detection": {},
  "summaries": [],
  "cells": [],
  "reports": [],
  "friendlySummaries": [],
  "consoleItems": []
}
```

默认人类输出只使用友好 renderer：

- 成功写命令输出一句完成状态和必要下一步。
- `aw status` 默认只展示插件、友好状态、友好位置和下一步。
- 普通 warning 不出现 `user scope`、`project scope` 或裸 `scope` 这类 prose 术语。
- 可复制命令、argv 数组、flag 名、JSON 字段和 TypeScript 类型可以保留真实技术标识。

`--verbose` 和 debug log 继续保留内部诊断：

- `ledger`
- `healthSource`
- `tracking`
- `artifactRefresh`
- `refreshKeys`
- `configDigest`
- `contentDigest`
- `sessionVisibility`
- `projectTrust`
- native enabled/cache/recovery 原始字段

### 子命令非交互合同

调整 `packages/cli/src/index.ts`、`commands/options.ts`、`commands/interactive.ts` 和相关 command action。

要求：

- `install` / `uninstall` / `upgrade` help 中不再出现 `-i/--interactive` 或 `--no-interactive`。
- `config configure` 不再注册。
- `config reset` help 中不再出现 `-i/--interactive` 或 `--no-interactive`。
- 旧 flag 走 commander unknown option。
- 旧 `config configure` 走 unknown command。
- `install` 缺插件名时失败，不进入 prompt。
- `uninstall` 缺插件名时失败，不进入 prompt。
- `upgrade` 缺插件名且没有 `--all` 时失败，不进入 prompt。
- `config reset <plugin>` 目标 store 存在且未传 `--yes` 时失败，不进入 prompt。
- 子命令不会使用 fake prompt，即使 runtime 注入了 prompt。

旧 `commands/interactive.ts` 的候选构建能力可以拆出只读 helper 给 TUI 复用；旧子命令 prompt dispatch 应删除。

## 阶段计划

### 阶段 0：基线锁定与合同复核

- [ ] 复核当前入口和输出：
  - `packages/cli/src/index.ts`
  - `packages/cli/src/commands/runtime.ts`
  - `packages/cli/src/commands/interactive.ts`
  - `packages/cli/src/commands/install.ts`
  - `packages/cli/src/commands/uninstall.ts`
  - `packages/cli/src/commands/upgrade.ts`
  - `packages/cli/src/commands/status.ts`
  - `packages/cli/src/commands/discovery.ts`
  - `packages/cli/src/commands/common.ts`
  - `packages/cli/src/output/reporter.ts`
  - `packages/cli/src/utils/plugin-config.ts`
  - `packages/cli/src/utils/artifact-refresh.ts`
- [ ] 用当前测试或新增最小 regression tests 锁住旧问题：直接运行 `aw` 显示 help、子命令缺参进入 prompt、默认输出泄露内部词、enabled-only 被误判、refresh failed 默认文案泄露内部字段。
- [ ] 做一次 JSON receipt schema review，确定 `targets`、`actions`、`native`、`artifactRefresh`、`friendlySummaries` 和 `consoleItems` 的字段名。
- [ ] 验证 `@inquirer/prompts` 在项目实际 registry 下可安装，并记录可用版本。

完成标准：关键旧行为可复现，JSON 字段草案冻结，新依赖可安装性明确。

### 阶段 1：友好状态投影

- [ ] 新增 `PluginConsoleItem`、`PluginConsoleLocation`、`PluginConsoleAction`、`PluginConsoleReasonCode` 类型。
- [ ] 实现从 `StatusMatrixReport` 到 console items 的投影入口。
- [ ] 实现位置标签：`Codex（个人）`、`Codex（当前项目）`、`Claude Code（个人）`、`Claude Code（当前项目）`、`多个位置`。
- [ ] 实现状态优先级和跨位置汇总规则。
- [ ] 实现 conservative upgrade 判定。
- [ ] 映射 Codex user native 状态：
  - enabled config + active cache + AW record 健康才可视为已安装。
  - enabled-only、cache-only、breadcrumb-only 不显示为已安装。
  - recovery breadcrumb 映射 `nativeIncomplete`。
  - 无归属残留映射 `nativeResidue`，不生成 cleanup 动作。
- [ ] 映射 dynamic artifact 状态：
  - refresh failed 映射 `artifactRefreshFailed`。
  - drift / missing 映射 `artifactDrift`。
  - disabled by config 不算问题。
- [ ] 映射 session visibility：
  - `blockedByProjectTrust`、`projectTrustUnknown` -> `partial + projectVisibilityBlocked`。
  - `shadowedByProjectDeveloperInstructions`、`unknownByExternalLayer` -> `partial + sessionVisibilityLimited`。
- [ ] 映射外部 ownership、配置缺失/无效/不可读、tracking identity、role/MCP、unmanaged artifact、catalog capability changed、catalog unavailable；`catalogUnavailable` 必须覆盖 current catalog 缺失、不可读/不可解析、插件已不在 current catalog 中。
- [ ] 给每种原因码生成动作、说明和诊断命令 argv。
- [ ] 友好原因文案模板必须集中生成 `issueSummary`、`detailHints` 和下一步说明，并遵守 spec 的 prose 禁词合同；可复制命令、argv、flag、JSON 字段和代码类型保留真实技术标识。
- [ ] 固化 action 安全不变量：多位置汇总项不承载隐式批量写动作。
- [ ] 所有写动作只能来自 `PluginConsoleLocation.actions`，并带明确 `target.platform`、`target.scope` 和必要的 `projectKey`。
- [ ] 所有删除、覆盖、cleanup 动作都设置 `destructive: true` 和 `confirmText`。
- [ ] disabled 动作必须提供 `disabledReason`；TUI 只能读取结构化字段，不能靠中文 `label` 推断行为。

完成标准：单元测试能用纯 status/discovery fixture 覆盖全部原因码、状态优先级、跨位置汇总、action contract 和友好原因文案禁词合同。

### 阶段 2：`status` 友好摘要与 JSON 兼容字段

- [ ] 调整 `statusCommand()`，在现有矩阵生成后调用友好投影层。
- [ ] `status --json` 顶层追加 `ok`、`command`、`friendlySummaries`、`consoleItems`，不破坏现有 `detection`、`summaries`、`cells`、`reports`。
- [ ] `status --json` 失败路径也必须守住 stdout 机器合同；discovery、current catalog、adapter 诊断或配置读取异常时，stdout 为空或仍是单一可解析 JSON，错误只写 stderr。
- [ ] 默认 `aw status` 改为友好摘要，展示插件名、状态、位置和下一步。
- [ ] `status --verbose` 继续输出诊断矩阵，内部字段放在 `诊断信息` 小节。
- [ ] 默认 status 文案过滤内部术语，保留可复制命令里的真实 flag。
- [ ] 覆盖 current catalog 缺失、不可读/不可解析、插件已不在 current catalog 中、Codex native recovery、cache-only、enabled-only、dynamic artifact refresh failed、project trust、session visibility 等状态。

完成标准：默认 `aw status` 不泄露禁用 prose；`status --json` 旧字段可继续解析，新字段覆盖 TUI 所需数据，异常路径不污染 stdout。

### 阶段 3：JSON receipt 与默认写命令输出

- [ ] 抽出或重写 `writeCommandReceipt()`，把机器 receipt 和人类 renderer 分离。
- [ ] `init --json` 输出 `{ ok, command, ... }`。
- [ ] `install --json` 输出纯 JSON，包含 plugins、targets、actions、artifacts、native、warnings、nextSteps。
- [ ] `uninstall --json` 输出纯 JSON，包含清理动作、native 结果、artifacts 和 warnings。
- [ ] `upgrade --json` 输出纯 JSON，包含 upgraded、skipped、targets、actions、native、artifacts。
- [ ] `config set/unset/reset --json` 保持纯 JSON，并稳定输出 `artifactRefresh`。
- [ ] `config list/get --json` 继续输出稳定 `ok`、`command` 和既有数据结构，不被 receipt renderer 重构误伤。
- [ ] 失败时 stdout 不输出半份 JSON；错误和人类 warning 走 stderr。
- [ ] 默认成功输出降噪，不展示 marketplace、app-server、RPC、cache、recovery、repo-managed、ledger、healthSource、config/script health 等内部词。
- [ ] `formatWarnings()` 或 warning model 分层，只让用户可行动 warning 进入默认输出。

完成标准：所有 `--json` stdout 可 `JSON.parse`；默认写命令输出只包含友好完成句和必要下一步。

### 阶段 4：配置写入 helper 与 refresh-only 动作

- [ ] 抽出共享 config 写入 helper，统一校验、store patch、effective config 重算和 artifact refresh。
- [ ] 改造 `config set` 使用 helper。
- [ ] 改造 `config unset` 使用 helper。
- [ ] 改造 `config reset --yes` 使用 helper，并保留 current catalog 缺失时的 raw-store 删除分支。
- [ ] raw-store 删除分支必须先调用 `assertSafePluginConfigSegment()` 或等价校验，校验失败时不删除任何文件。
- [ ] 删除 `config configure` 命令实现前，先把其可复用 schema 表单逻辑迁移给 TUI。
- [ ] schema 表单逻辑必须保留 sensitive 字段的现有 UX：已有值只显示 `已配置` 占位，不回显真实值，也不因为显示占位而要求用户重新输入。
- [ ] 实现多字段一次提交 API，供 TUI 配置向导调用。
- [ ] 多字段一次提交 API 必须同时承载 `updates` 和 `removeKeys`，或等价的更新/删除意图模型，并返回 `updatedKeys` / `removedKeys`。
- [ ] 可选字段已有值时，配置向导能在同一轮保存中显式清空；清空 key 进入 `removedKeys`，不进入 `updatedKeys`。
- [ ] `artifactRefresh.triggerKeys` 与本轮 `updatedKeys + removedKeys` 对齐；只删除不更新、只更新不删除、更新和删除混合提交都只 patch 一次、refresh 一次。
- [ ] 实现 `reapplyConfigRefresh`，不修改 config store；优先使用 tracking 中失败 artifact 记录的 `refreshKeys`，没有这类失败记录时退回当前目标全部 tracked refresh keys。
- [ ] refresh 成功、失败、skipped 都返回稳定 receipt。
- [ ] `reapplyConfigRefresh` 成功后必须让后续 `aw status --json` / `aw status --verbose` 读到新的 `lastRefresh` 和 tracking 诊断。
- [ ] `reapplyConfigRefresh` 失败后必须保留配置，并让后续 `aw status --json` / `aw status --verbose` 读到本次 `artifactRefresh.error`。
- [ ] 覆盖 sensitive 值脱敏和不复制另一层 effective config 的测试。

完成标准：脚本化 config 命令和 TUI 配置向导复用同一条写入/refresh 路径；refresh-only 动作不会改写配置，并且成功/失败结果能被后续 status 诊断读到。

### 阶段 5：子命令去交互

- [ ] 从 `install` 删除 `-i/--interactive` 和 `--no-interactive`。
- [ ] 从 `uninstall` 删除 `-i/--interactive` 和 `--no-interactive`。
- [ ] 从 `upgrade` 删除 `-i/--interactive` 和 `--no-interactive`。
- [ ] 删除 `config configure` 注册。
- [ ] 从 `config reset` 删除 `-i/--interactive` 和 `--no-interactive`。
- [ ] `install` 缺插件名时直接失败，提示运行 `aw` 或 `aw install <plugin>`。
- [ ] `uninstall` 缺插件名时直接失败，提示运行 `aw` 或 `aw uninstall <plugin>`。
- [ ] `upgrade` 缺插件名且无 `--all` 时直接失败，提示运行 `aw` 或 `aw upgrade <plugin>` / `aw upgrade --all`。
- [ ] install / upgrade 缺 required config 时失败，不 prompt，提示 `aw config set ...` 或 `aw` 主入口。
- [ ] `config reset` 需要确认时必须传 `--yes`，否则失败，不 prompt。
- [ ] 删除子命令对 `createInteractiveInstallPlan()`、`createInteractiveUninstallPlan()`、`createInteractiveUpgradePlan()` 的调用。
- [ ] 评估 `commands/interactive.ts`：删除，或拆成只读候选 helper 给 TUI。

完成标准：旧交互 flag 和 `config configure` 都按 unknown option/unknown command 处理；子命令不再调用 prompt。

### 阶段 6：安全预检与 TUI 写入编排

- [ ] 把安装/升级前安全预检抽成可由 TUI 调用的只读入口。
- [ ] 只读预检入口返回结构化失败原因和可行动下一步，供 TUI 展示友好说明。
- [ ] 覆盖 Codex project write safety。
- [ ] 覆盖用户级 Codex config 可读性。
- [ ] 覆盖 project Codex config 可读性。
- [ ] 覆盖 external ownership。
- [ ] 覆盖 tracking identity。
- [ ] 覆盖 role/MCP 冲突。
- [ ] 覆盖 unmanaged artifact conflict。
- [ ] 安全预检失败时，TUI 不调用 required config 表单，不创建 config store，不写 native state、artifact、tracking 或 ledger。
- [ ] mixed target 安装/升级在预检通过后，只提示一次 required config。
- [ ] `repairInstall` 复用 install/upgrade 语义，不绕过 native post-check、tracking identity 或 external ownership。
- [ ] `cleanupRecovery` 只处理证据匹配的受控 recovery breadcrumb，复用 uninstall recovery 语义。

完成标准：TUI 可调用的安装/升级只读预检模型先于主入口写入流程落地；预检失败路径保持完全只读，并被测试锁住不调用 required config 表单、不创建 config store、不写 native state、artifact、tracking 或 ledger。

### 阶段 7：主入口 TUI 与 prompt adapter

- [ ] 引入 `@inquirer/prompts` 依赖。
- [ ] 实现默认 inquirer prompt adapter。
- [ ] 扩展 runtime，让 `runCli([])` 能进入主控制台。
- [ ] 非 TTY、CI 或交互不可用时，主入口失败并输出清晰说明、可复制命令和 `--json` 机器可读输出提示。
- [ ] 实现首屏列表，支持方向键滚动、插件状态、描述和位置摘要。
- [ ] 实现详情页，展示位置详情、友好状态、原因说明和 location-level 动作。
- [ ] 实现安装向导：平台、位置、触发方式、只读安全预检和必填配置；预检通过后才进入 required config 表单。
- [ ] 实现配置向导：按 schema 生成输入、确认、枚举、隐藏输入和校验；sensitive 字段已有值时只显示 `已配置` 占位，不回显真实值，保留现有值时不要求重新输入。
- [ ] 配置向导必须支持显式清空已有可选字段，并把保存结果传给共享 helper，使本轮提交的 `updatedKeys`、`removedKeys` 和 `artifactRefresh.triggerKeys` 一致。
- [ ] 配置向导写入位置默认跟当前安装位置一致；插件尚未安装时默认 `个人`，但允许用户改选 `当前项目`。
- [ ] 实现升级、卸载、修复安装、受控 cleanup、重新应用配置和诊断命令动作。
- [ ] `artifactRefreshFailed` 触发 `重新应用配置` 时，如果 refresh-only helper 返回 `skipped` 且原因是没有可定位 tracked dynamic artifact，TUI 展示 `没有需要重新应用的项目文件`，receipt 仍保留 `artifactRefresh.status = skipped`。
- [ ] 破坏性动作二次确认；取消后不写状态。
- [ ] current catalog 缺失、不可读/不可解析，或插件已不在 current catalog 中时，详情页不展示升级或 schema 配置动作，只保留卸载、查看诊断命令和返回。
- [ ] 同一插件多个位置时，详情页必须先选明确位置，再执行写动作。

完成标准：fake prompt 下可以完整跑通主入口安装、升级、配置、卸载、取消和诊断命令流程，并覆盖重新应用配置 skipped 反馈；安装/升级断言必须覆盖“先只读安全预检，再 required config 表单”的顺序；真实 TUI 支持方向键和返回。

### 阶段 8：文档与作者工具同步

- [ ] 更新 `README.md`。
- [ ] 更新 `docs/plugin-installation.md`。
- [ ] 更新 `docs/architecture.md`。
- [ ] 更新 `docs/testing.md`。
- [ ] 更新 `docs/dev/plans/codex-explorer-plugin.md` 中对 `aw config configure` 的旧描述。
- [ ] 搜索并删除或改写 `--interactive`、`--no-interactive`、`config configure` 的公开说明。
- [ ] 检查 `.agents/skills/create-agent-workflows-plugin/`：
  - `SKILL.md`
  - references
  - templates
  - example plugins
  - tests/fixtures
- [ ] 更新插件作者说明：配置向导只在 `aw` 主控制台，脚本化配置入口是 `config set/unset/reset`。
- [ ] 更新 JSON receipt、默认输出、verbose/debug/json 分层说明。
- [ ] 更新 Codex user native enabled/cache/recovery 语义说明。
- [ ] 更新 dynamic artifact refresh 和友好状态投影说明。

完成标准：仓库内不再有面向用户的旧交互入口说明；插件作者技能和公开文档与新 CLI 合同一致。

### 阶段 9：回归、smoke 与发布前检查

- [ ] 跑 `pnpm test:unit`。
- [ ] 跑 `pnpm test:integration`。
- [ ] 跑 `pnpm build`。
- [ ] 跑 `pnpm test:smoke:build`。
- [ ] 如依赖打包或 tarball 内容有风险，补跑 `pnpm test:smoke:pack`。
- [ ] 检查 `packages/cli/plugins-dist` runtime bundle。
- [ ] 人工试跑真实 TTY：
  - `aw`
  - `aw status`
  - `aw install <plugin> --json`
  - `aw config set/unset/reset --json`
- [ ] 人工试跑非 TTY，断言退出码非 0、不挂起，并包含 `--json` 提示：
  - `aw < /dev/null`
  - `CI=true aw`

完成标准：单测、集成、build、smoke 通过；真实 TTY 和非 TTY 行为符合 spec。

## 测试矩阵

### Unit

- [ ] 友好投影：六类首屏状态。
- [ ] 友好投影：全部原因码。
- [ ] 友好投影：跨位置汇总。
- [ ] 友好投影：状态优先级。
- [ ] 友好投影：保守升级判定。
- [ ] 友好投影：外部来源纯外部 vs 外部/AW 冲突。
- [ ] 友好投影：Codex enabled-only、cache-only、breadcrumb-only 不算已安装。
- [ ] 友好投影：Codex native recovery 生成 repair / controlled cleanup 动作。
- [ ] 友好投影：无归属 native residue 不生成 cleanup 动作。
- [ ] 友好投影：dynamic artifact refresh failed 生成 `reapplyConfigRefresh`。
- [ ] 友好投影：disabled by config 不算问题。
- [ ] 友好投影：四种 session visibility 映射为 `partial`。
- [ ] 友好投影：`status --json.consoleItems[].locations[].actions[]` 字段完整。
- [ ] 友好投影 action contract：多 location item 的 `PluginConsoleItem.actions` 不出现 `runUpgrade`、`runUninstall`、`openConfigWizard` 等隐式批量写动作。
- [ ] 友好投影 action contract：`PluginConsoleItem.actions` 不包含任何立即写状态的 action kind，包括 `runInstall`、`runUpgrade`、`runUninstall`、`repairInstall`、`cleanupRecovery`、`reapplyConfigRefresh`；这些动作只能出现在 `locations[].actions[]`。
- [ ] 友好投影 action contract：所有写动作都有 `target`；project 动作在需要时带 `projectKey`。
- [ ] 友好投影 action contract：删除、覆盖、cleanup 动作都有 `destructive: true` 和 `confirmText`。
- [ ] 友好投影 action contract：disabled 动作必须带 `disabledReason`，TUI 不依赖 `label` 判断行为。
- [ ] 友好投影 action contract：`catalogUnavailable` 分别覆盖 current catalog 缺失、不可读/不可解析、插件已不在 current catalog 中；三个场景都不生成 `runUpgrade` 或 `openConfigWizard`，只生成卸载、查看诊断命令和返回。
- [ ] 友好原因文案：每个 `PluginConsoleReasonCode` 生成的 `issueSummary`、`detailHints` 和下一步说明不泄露 spec 禁用 prose；可复制命令、argv、flag、JSON 字段和代码类型里的真实标识作为例外保留。
- [ ] 安装向导模型：不需要或不允许覆盖 skill trigger 时不展示触发方式；需要覆盖时只显示 `默认`、`手动`、`自动`。
- [ ] 安装向导模型：不可安装或需改选组合返回友好原因，覆盖当前项目能力不支持、Codex native 不可用但 project 写入可行、外部 ownership 阻断。
- [ ] 安装/升级只读预检模型：预检失败时不调用 required config 表单，不创建 config store，不写 native state、artifact、tracking 或 ledger。
- [ ] 安装/升级只读预检模型：mixed target 预检通过后，同一插件只触发一次 required config 表单，后续目标复用重新解析后的 effective config。
- [ ] 配置向导模型：从已安装位置进入时默认写入该位置。
- [ ] 配置向导模型：插件尚未安装时默认 `个人`，但仍可选择 `当前项目`。
- [ ] 配置向导模型：sensitive 字段已有值时只显示 `已配置` 占位，不回显真实值；用户保留现有值时不把字段误判为缺失或待重新输入。
- [ ] 配置向导模型：已有可选字段支持显式清空；清空时结果包含 `removedKeys`，且不把该 key 放入 `updatedKeys`。
- [ ] 配置向导模型：同一轮更新和清空混合提交时，同时生成 `updatedKeys` 和 `removedKeys`。
- [ ] 配置写 helper：多字段一次校验。
- [ ] 配置写 helper：任一字段非法时不写 store、不 refresh。
- [ ] 配置写 helper：一次 patch、一次 refresh。
- [ ] 配置写 helper：只删除不更新、更新和删除混合提交都返回正确 `removedKeys`。
- [ ] 配置写 helper：`artifactRefresh.triggerKeys` 与本轮 `updatedKeys + removedKeys` 对齐。
- [ ] 配置写 helper：不复制另一层 effective config。
- [ ] 配置写 helper：sensitive 值不泄露。
- [ ] 配置 reset：current catalog 缺失时 raw-store 删除成功，refresh skipped。
- [ ] 配置 reset：current catalog 缺失时，`../bad`、空字符串、绝对路径、带协议前缀等非法插件名被拒绝，且不删除任何文件。
- [ ] refresh-only：存在失败 artifact `refreshKeys` 时，按失败记录重跑 refresh。
- [ ] refresh-only：不存在失败 artifact 记录但当前目标仍有 tracked refresh keys 时，按目标全量 tracked keys 重跑 refresh。
- [ ] refresh-only：成功后更新 tracked artifact 的 `lastRefresh` 和 tracking 诊断。
- [ ] refresh-only：失败后保留 config store，并在 tracking 与 receipt 中记录新的 `artifactRefresh.error`。
- [ ] refresh-only：无 tracked dynamic artifact 时 skipped。
- [ ] 输出 renderer：默认文案不包含内部禁词。
- [ ] warning 分类：默认只显示用户可行动 warning。

### Integration

- [ ] `runCli([])` + fake prompt 进入控制台并完成安装。
- [ ] `runCli([])` 非 TTY/CI 不挂起，返回清晰错误、示例和 `--json` 机器可读输出提示。
- [ ] 首屏候选来自 current catalog + AW 记录 + native evidence + tracking。
- [ ] 同名插件多个位置首屏只显示一个 item。
- [ ] 多位置详情页要求选择明确位置，不触发隐式批量配置、卸载或升级。
- [ ] 未安装状态只显示安装。
- [ ] 已安装状态显示升级、配置、卸载。
- [ ] 需要处理状态显示问题说明和修复动作。
- [ ] 部分可用状态显示配置、卸载、诊断和返回，不自动降级为修复安装。
- [ ] 由其它来源管理只显示说明和返回。
- [ ] current catalog 缺失、不可读/不可解析、插件已不在 current catalog 中时不显示升级或 schema 配置动作，只显示卸载、诊断和返回。
- [ ] 安装向导覆盖平台、位置、触发方式、必填配置。
- [ ] 安装向导只在插件需要且允许覆盖 skill trigger 时展示触发方式。
- [ ] 安装向导对不可安装或需改选组合显示友好原因，至少覆盖 project capability 不支持、Codex native 不可用但项目写入可行、外部 ownership 阻断。
- [ ] 配置向导覆盖 string、file、directory、number、boolean、enum、sensitive。
- [ ] 配置向导已有 sensitive 配置时只展示 `已配置` 占位，不泄露真实值；用户不改该字段时保存不会清空或误报缺失。
- [ ] 配置向导能在同一轮保存中清空已有可选字段；receipt 的 `removedKeys` 和 `artifactRefresh.triggerKeys` 与清空 key 对齐。
- [ ] 配置向导同一轮混合更新和清空时，只写一次 config store，只触发一次 artifact refresh。
- [ ] 从 `Codex（当前项目）` 位置打开配置时默认写 project store，不误写 user store。
- [ ] 未安装插件选择 `当前项目` 配置位置时只写 project store。
- [ ] 配置保存命中 refresh key 后，成功、失败、skipped 都有 receipt。
- [ ] `artifactRefreshFailed` 选择重新应用配置后，不修改 config store，只刷新 artifact。
- [ ] `artifactRefreshFailed` 重新应用配置成功后，`aw status --json` 和 `aw status --verbose` 能读到新的 `lastRefresh` / tracking 诊断。
- [ ] `artifactRefreshFailed` 重新应用配置失败后，`aw status --json` 和 `aw status --verbose` 能读到本次 `artifactRefresh.error`。
- [ ] `artifactRefreshFailed` 重新应用配置没有可定位 tracked dynamic artifact 时，TUI 显示 `没有需要重新应用的项目文件`，且 receipt 返回 `artifactRefresh.status = skipped`。
- [ ] Codex project 安全预检失败时，TUI 不调用 required config 表单，不写任何状态。
- [ ] 安全预检失败覆盖 config 不可读、external ownership、tracking identity、role/MCP、unmanaged artifact。
- [ ] mixed target 安装/升级只提示一次 required config。
- [ ] 卸载二次确认；取消不写状态。
- [ ] `aw install --interactive` 返回 unknown option。
- [ ] `aw install --no-interactive` 返回 unknown option。
- [ ] `aw uninstall --interactive` 返回 unknown option。
- [ ] `aw uninstall --no-interactive` 返回 unknown option。
- [ ] `aw upgrade --interactive` 返回 unknown option。
- [ ] `aw upgrade --no-interactive` 返回 unknown option。
- [ ] `aw config configure` 返回 unknown command。
- [ ] `aw config reset <plugin> --interactive` 返回 unknown option。
- [ ] `aw config reset <plugin> --no-interactive` 返回 unknown option。
- [ ] `aw config reset <plugin>` 需要确认时失败并提示 `--yes`。
- [ ] `aw install` 缺插件名失败并提示运行 `aw` 或 `aw install <plugin>`。
- [ ] `aw uninstall` 缺插件名失败并提示运行 `aw` 或 `aw uninstall <plugin>`。
- [ ] `aw upgrade` 缺插件名且无 `--all` 失败并提示运行 `aw` 或 `aw upgrade <plugin>` / `aw upgrade --all`。
- [ ] 子命令即使注入 fake prompt 也不会 prompt。

### JSON 与输出

- [ ] `init --json` stdout 是单一 JSON。
- [ ] `install --json` stdout 是单一 JSON，包含 `ok`、`command`、`plugins`、`targets`、`actions`。
- [ ] `uninstall --json` stdout 是单一 JSON。
- [ ] `upgrade --json` stdout 是单一 JSON。
- [ ] `config set/unset/reset --json` stdout 是单一 JSON，命中 refresh 时包含 `artifactRefresh`。
- [ ] `config unset --json` 和共享 helper receipt 包含 `removedKeys`；删除触发 refresh 时，`artifactRefresh.triggerKeys` 与删除 key 对齐。
- [ ] `config list/get --json` stdout 继续包含稳定 `ok`、`command`，既有数据结构不变。
- [ ] `status --json` 保持矩阵字段兼容，并追加 `ok`、`command`、`friendlySummaries`、`consoleItems`。
- [ ] `status --json` 覆盖 native enabled/cache/recovery 原始机器字段。
- [ ] `status --json` 覆盖 dynamic artifact health、session visibility 和 refresh metadata。
- [ ] JSON 失败路径：`init/install/uninstall/upgrade/config/status` 每类至少一个失败用例，断言 stdout 为空或保持单一可解析 JSON，错误只在 stderr。
- [ ] `status --json` 失败路径至少覆盖 current catalog 读取失败、adapter 诊断异常或配置文件不可读中的一种，断言 stdout 为空或保持单一可解析 JSON，错误只在 stderr。
- [ ] 所有 `--json` 场景 stderr 不影响 stdout 解析。
- [ ] 成功安装默认输出不包含 marketplace、app-server、RPC、cache、recovery breadcrumb、账本、degraded、healthSource、config=no-schema、scripts=not_declared、repo-managed。
- [ ] 默认 `aw status` 不包含 pluginEnabled、pluginInstalled、artifactRefresh、refreshKeys、configDigest、contentDigest、sessionVisibility、projectTrust。
- [ ] 默认人类输出和 TUI prose 不出现 `user scope`、`project scope` 或裸 `scope`。
- [ ] 可复制命令、argv 数组、flag 名、JSON 字段和代码类型中的 `--scope` / `scope` 作为例外保留。
- [ ] `aw status --verbose` 可以显示诊断字段。

### 回归安全

- [ ] Codex project scope 安装仍不要求 native Codex runner。
- [ ] Codex user scope 继续走 app-server RPC 和 post-check。
- [ ] Codex project scope 只写当前项目文件，不产生用户级 native 副作用。
- [ ] Codex user scope 和 Claude native runtime 仍按需同步 `~/.aw`。
- [ ] 外部 marketplace ownership 仍阻断危险写入。
- [ ] required config 在子命令中失败，在 TUI 中走向导。
- [ ] rollback/degraded 写入语义保留，但默认文案不暴露内部状态名。
- [ ] `status` 仍保持只读，不创建、同步或修复 `~/.aw`。
- [ ] `status` 不执行 artifact renderer、lifecycle 或 app-server。

### Smoke

- [ ] `pnpm build` 产物包含 `@inquirer/prompts` 运行依赖。
- [ ] `pnpm test:smoke:build` 覆盖 runtime bundle。
- [ ] 如执行 pack smoke，tarball 包含新 TUI 所需依赖和 dist 文件。
- [ ] 真实 TTY 中 `aw` 不退回 help。
- [ ] 非 TTY 中 `aw` 不挂起，并提示机器可读输出使用 `--json`。

## 推荐落地顺序

1. 先落友好状态投影和 `status --json.consoleItems`，因为 TUI、默认 status 和测试都依赖这层。
2. 再落 JSON receipt 和输出分层，避免后续 TUI 调命令时继续继承旧 receipt 噪音。
3. 接着抽配置写 helper 和 refresh-only 动作，给配置向导打地基。
4. 删除子命令交互入口，先让脚本化合同稳定。
5. 抽出 TUI 可调用的只读安全预检与写入编排，先锁住“失败前不写状态”的安装/升级不变量。
6. 最后接入 `@inquirer/prompts` 和主入口 TUI，把 UI 绑定到已经稳定的投影、预检模型和命令 API。
7. 收尾做文档、作者技能和 smoke。

## 关键风险

- 这是 breaking change，旧 `--interactive` / `--no-interactive` / `config configure` 会直接消失，文档必须一次性同步。
- `@inquirer/prompts` 的 registry 可用性和打包结果需要提前验证。
- JSON receipt 一旦发布就会变成脚本合同，字段命名必须先 review 再实现。
- 友好投影如果分散实现，TUI、默认 status 和 JSON 很容易状态不一致。
- 默认输出降噪后，诊断信息必须可靠进入 `--verbose`、`--debug` 和 JSON。
- 安装/升级向导如果在安全预检前写 config store，会破坏 spec 的只读失败保证。
- 配置向导如果只记录 `updatedKeys`，会丢失“显式清空已有配置”的提交语义，并让 `artifactRefresh.triggerKeys` 和实际变更脱节。
- action contract 如果只测试多位置场景，单位置 item-level 写动作可能绕过明确 target 边界。
- `reapplyConfigRefresh` 如果复用配置表单保存路径，容易误写 config store，必须单独测试。
- `scope` 禁词规则有技术片段例外，测试不能简单全文禁止 `scope`。

## 最终验收清单

- [ ] `aw` 是唯一交互入口，TTY 下进入控制台，非 TTY 下确定性失败并提示 `--json`。
- [ ] 子命令没有任何 prompt 路径。
- [ ] 旧交互 flag 和 `config configure` 已移除。
- [ ] 默认人类输出不泄露内部实现词。
- [ ] `aw status` 默认输出使用友好摘要。
- [ ] `status --json` 兼容旧矩阵字段，并提供 `consoleItems`。
- [ ] 写命令 `--json` 全部输出单一 JSON receipt。
- [ ] TUI、默认 status 和 JSON 复用同一友好投影层。
- [ ] Codex native enabled/cache/recovery 不会被误判为普通已安装。
- [ ] dynamic artifact refresh failed、drift、session visibility、project trust 都能被用户理解并有下一步。
- [ ] 配置向导和脚本化 config 命令复用同一写入/refresh helper，并能表达 `updatedKeys`、`removedKeys` 与 `artifactRefresh.triggerKeys` 的同轮提交语义。
- [ ] 配置向导默认写入当前安装位置；未安装插件默认 `个人`，且可改选 `当前项目`。
- [ ] `reapplyConfigRefresh` 不修改 config store，成功/失败结果都会写回 tracking 并能被后续 status 诊断读取。
- [ ] action 安全不变量有测试覆盖：立即写状态的动作只来自 `PluginConsoleLocation.actions`，并带完整 target；`PluginConsoleItem.actions` 不存在隐式写动作或隐式批量写动作。
- [ ] `config list/get --json` 和 JSON 失败通道都有回归测试。
- [ ] 安全预检失败时 TUI 不写任何状态。
- [ ] README、docs、开发计划和插件作者技能已同步。
- [ ] `pnpm test:unit`、`pnpm test:integration`、`pnpm build`、`pnpm test:smoke:build` 通过。
