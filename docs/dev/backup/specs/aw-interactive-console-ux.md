# `aw` 交互控制台与安装输出重设计需求 Spec

日期：2026-04-30
基线复核：2026-05-05

## 背景

上一轮 `codex-install-native-interactive-ux` 已经把交互式安装、候选发现、默认输出、debug 日志和 `status` 面板都落到了代码里，但真实体验仍然失败：

- 交互只能输入编号，不能用方向键移动、回车确认。
- `install` 成功后仍会混入用户不需要理解的状态信息，例如 lifecycle snapshot、marketplace、账本、`degraded`、`healthSource`、`config=no-schema`、`scripts=not_declared`。
- 状态输出把内部模型直接暴露给用户，例如 `Codex / git-commit / user scope`、`ledger`、`repo-managed`、`skill trigger drift`。
- `install` / `uninstall` / `upgrade` / `config` 子命令都可能进入 prompt，导致脚本化入口和交互入口混在一起。

本 spec 重新定义交互入口和默认输出：`aw` 主命令是唯一交互入口；子命令只服务非交互脚本调用；默认人类输出只展示用户能理解、能行动的信息。

2026-05-05 复核后，当前基线又合入了两条能力：

- `codex-explore` 插件和 dynamic artifact renderer：状态里会出现 Codex instruction / role artifact、配置触发刷新、refresh failed、project trust / session visibility 等新诊断。
- Codex user native install / uninstall RPC：Codex user scope 的“可用”不再等同于 config enabled，而是至少需要 enabled config、active cache、成功 AW scope record 且没有 native recovery breadcrumb。

因此本 spec 仍保留“主入口 TUI + 默认输出降噪”的主方向，但必须补齐这些新状态在控制台、默认输出、JSON receipt 和验收测试里的产品映射。

## 已确认决策

- 直接运行 `aw` 进入插件控制台。
- 插件控制台使用方向键交互，依赖指定为 `@inquirer/prompts`。
- 子命令删除所有交互模式。旧的 `-i/--interactive`、`--no-interactive` 和纯交互命令 `config configure` 直接移除。
- 首屏展示全部插件的简化汇总状态，不在列表中展开 Codex/Claude、user/project 的完整矩阵。
- 第一版不做批量操作，一次只进入一个插件详情页。
- 必填配置、安装位置、平台和 skill 触发等选择在主入口 TUI 里用向导完成。
- TUI 里只展示友好详情，不提供内部诊断页；内部诊断继续由 `aw status --verbose`、`--debug` 和 JSON 输出承担。
- 非 TTY 中直接运行 `aw` 返回明确错误和可复制的非交互命令示例。
- `aw status` 默认仍是给人看的友好摘要，但不再输出内部术语；诊断字段只进 `--verbose` / `--json` / debug log。
- 脚本化子命令补齐 JSON receipt。所有命令的 `--json` stdout 必须是纯 JSON。
- 2026-05-05 复核后继续确认：不保留 `config configure` 作为过渡入口；配置向导只存在于 `aw` 主控制台，脚本化配置入口保留 `config set` / `unset` / `reset`。
- 新增状态不扩充首屏顶层枚举；Codex native recovery、cache-only、dynamic artifact refresh failed 等情况统一落到 `需要处理` 或 `部分可用`，详情页用友好原因码和动作解释。
- Codex user native 成功输出只说“插件已可用”和位置，不默认提 `app-server`、RPC、cache 或 recovery 细节。

## 当前实现探索结论

### CLI 入口

- [packages/cli/src/index.ts](../../../../packages/cli/src/index.ts) 当前只注册子命令，直接运行 `aw` 会显示 help 并返回非 0。
- `install`、`uninstall`、`upgrade` 的参数是 `[plugins...]`，缺插件名时会在 CLI runtime 里尝试进入交互计划。
- `config configure` 和 `config reset` 仍会调用 prompt；`config configure` 本身没有非交互语义。
- `init`、`install`、`uninstall`、`upgrade` 还没有 JSON receipt；`status` 和多数 `config` 子命令已有 JSON。
- 新基线中 `config set` / `unset` / `reset` 已接入 dynamic artifact refresh；移除 `config configure` 时，必须保留这三条脚本化写入口的 refresh receipt，并让主入口配置向导复用同一套 refresh 语义。

### 交互实现

- [packages/cli/src/commands/runtime.ts](../../../../packages/cli/src/commands/runtime.ts) 的 `createReadlinePrompt()` 基于 `readline/promises`，`select` / `multiSelect` 会打印编号列表，要求用户输入编号或逗号分隔的编号。
- [packages/cli/src/commands/interactive.ts](../../../../packages/cli/src/commands/interactive.ts) 已有 install/uninstall/upgrade 的候选构建和分组 dispatch，但它服务子命令 prompt，不适合作为新的主入口控制台直接复用。
- 当前 prompt 接口包括 `selectScope`、`selectPlatform`、`selectPlugins`、`selectUpgradeMode`、`selectSkillTrigger`、`configurePlugin`。新设计可以保留其中的测试注入思路，但默认实现需要换成 TUI 控制器。

### 状态与候选发现

- [packages/cli/src/commands/discovery.ts](../../../../packages/cli/src/commands/discovery.ts) 已能从 current catalog、AW 安装记录、tracking manifest、Codex native config/cache/recovery、Claude settings/runtime evidence 合并候选。
- [packages/cli/src/commands/status.ts](../../../../packages/cli/src/commands/status.ts) 已有状态矩阵和 JSON 结构，但默认文案仍把矩阵细节直接展开，包含 `healthSource`、`config`、`scripts`、证据来源、`repo-managed`、`artifact` health、session visibility 等内部字段。
- Codex user native 状态已拆成 `pluginEnabled`、`pluginInstalled`、`configEntryPresent`、`cacheStatus`、`native.recovery`。友好投影不能再把 enabled config 当成“已安装”。
- Codex dynamic artifact 状态已进入 tracking/status；友好投影需要把 instruction / role artifact 映射成用户能理解的“轻量指令”“探索角色”“项目文件”等表达。
- 这些能力应保留为内部数据源，再投影成用户友好的 `PluginConsoleItem` / `PluginFriendlyStatus`，避免 UI 和默认输出直接暴露底层字段。

### 输出层

- `writeCommandReceipt()` 会打印 marketplace、插件目录、Codex app-server 原生安装、native 注册、repo-managed artifacts 和 `aw status` 下一步。对用户来说信息密度过高。
- `formatWarnings()` 会把 warning 源格式化成 `Codex / git-commit / user scope`，并把部分内部词翻译成中文，但仍然保留“账本”“scope”等概念。
- `filterPostCommandDriftWarnings()` 只做了有限抑制，status 默认输出仍会暴露大量诊断细节。

### 依赖现状

- `packages/cli/package.json` 目前只有 `chalk`、`commander`、`fs-extra`、`toml-eslint-parser`、`yaml` 等依赖，没有方向键 prompt/TUI 库。
- 本机 `npm view` 被 registry 策略返回 403，实施前需要用项目实际 registry 验证 `@inquirer/prompts` 的可安装版本。spec 仍按已确认决策指定该依赖。

## 产品目标

1. 用户直接运行 `aw` 就能看到所有插件和状态，不需要先记住 `install/status/upgrade` 等子命令。
2. 交互过程支持方向键、回车、返回、确认，不再要求输入编号。
3. 默认输出不出现内部实现词汇，用户只看到“发生了什么”“现在能不能用”“下一步该做什么”。
4. 子命令成为稳定的非交互 API，适合脚本、CI 和文档复制。
5. JSON receipt 覆盖所有子命令，stdout 可直接解析。
6. 仍保留现有 discovery、install、upgrade、uninstall、config、status 的核心安全语义，包括 project scope 安全预检、外部 ownership 检查、rollback、debug log 和只读 status 边界。
7. 新基线里的 Codex native recovery、cache evidence、dynamic artifact refresh、project trust / session visibility 都必须进入友好状态投影，不能被默认输出隐藏成“已安装”或“未安装”。

## 非目标

- 第一版不做批量安装、批量卸载或多选批量升级。
- TUI 不展示完整诊断矩阵，不替代 `status --verbose`。
- 不改变插件 manifest/schema/scope 的底层语义。
- 不重新设计 native marketplace、native recovery breadcrumb、ledger、tracking 或 dynamic artifact 的持久化格式。
- 不在本轮引入远程 marketplace 浏览能力。

## 术语与文案规则

默认人类输出和 TUI 中禁止出现以下内部术语，除非用户显式进入 `--verbose`、`--debug` 或 JSON：

- `ledger`、`账本`
- `degraded`
- `healthSource`
- `installSnapshot`、`currentCatalog`、`historical`
- `repo-managed`
- `tracking`
- `scope`
- `config=no-schema`、`scripts=not_declared`
- `skill trigger drift`
- `app-server`、RPC、JSONL
- `pluginEnabled`、`pluginInstalled`、`configEntryPresent`、`active cache`、`cacheStatus`
- `native recovery breadcrumb`
- `artifactRefresh`、`refreshKeys`、`configDigest`、`contentDigest`
- `sessionVisibility`、`projectTrust`

以上禁用范围只覆盖面向人的 prose 文案、标题、状态标签、普通 warning 和 TUI 标签。可复制命令、argv 数组、flag 名、JSON 字段、TypeScript 类型/接口示例等技术片段必须保留真实技术标识，允许出现 `--scope` / `scope`，避免脚本化命令和机器合同失真。验收测试应断言 prose 不泄露 `scope` 术语，而不是简单断言默认 stdout/TUI 全文不包含 `scope`。

推荐替代表达：

- `user scope` -> `个人`
- `project scope` -> `当前项目`
- `Codex / git-commit / user scope` -> `git-commit 已安装到 Codex（个人）`
- `degraded ledger` -> `安装记录需要修复`
- `repo-managed artifacts` -> `已写入项目文件`
- `external marketplace ownership` -> `同名插件已由其它来源管理`
- `skill trigger` -> 仅在设置项里展示为 `触发方式`
- `native recovery breadcrumb present` -> `Codex 侧已写入，但 AW 未完成收尾`
- `cache-only` -> `Codex 中有残留，需要确认来源`
- `artifact refresh failed` -> `配置已保存，但相关项目文件刷新失败`
- `blockedByProjectTrust` -> `已写入项目文件，但当前仓库还未被 Codex 信任`
- `projectTrustUnknown` -> `已写入项目文件，但 AW 暂时无法确认当前仓库是否已被 Codex 信任`
- `shadowedByProjectDeveloperInstructions` -> `已安装到个人位置，但当前仓库的项目级指令会优先生效`
- `unknownByExternalLayer` -> `已写入，但当前会话里可能有更高优先级的同名配置`

默认输出的格式必须优先使用完整句子，避免像日志、patch note 或内部状态 dump。

## 主入口 TUI

### 启动行为

TTY 环境运行：

```bash
aw
```

进入插件控制台。

非 TTY、CI 或 stdin/stdout 不支持交互时，返回非 0，并输出：

- `aw` 主入口需要交互终端。
- 可复制命令示例，例如 `aw status`、`aw install <plugin> --platform codex --scope user`。
- 如果用户需要机器可读输出，提示使用 `--json`。

示例命令必须使用真实 CLI flag；命令片段里的 `--scope` 不属于默认文案禁词泄露。命令周围的说明文字仍应写成 `个人` / `当前项目` 等友好表达。

### 首屏

首屏展示插件列表，来源为 current catalog + 已安装或可发现插件。列表每一行至少包含：

- 插件名
- 简短描述
- 友好状态：`未安装`、`已安装`、`可升级`、`需要处理`、`部分可用`、`由其它来源管理`
- 简化位置摘要，例如 `Codex（个人）`、`Claude Code（当前项目）`、`多个位置`

首屏状态枚举不因为新基线继续扩张。复杂情况通过详情页原因码表达：

- Codex user native 已写入但 AW 未完成收尾 -> 首屏 `需要处理`
- Codex 只有 enabled config 或只有 active cache -> 首屏 `需要处理`
- dynamic artifact 最近刷新失败、内容漂移或缺失 -> 首屏 `需要处理`
- project scope 文件健康但当前会话不可见或信任状态未知 -> 首屏 `部分可用`
- Codex user scope 已写入且文件健康，但当前仓库会话被项目级 developer instructions 遮挡，或 AW 因更高优先级 layer 不能可靠判断可见性 -> 首屏 `部分可用`
- dynamic instruction 被配置关闭且其它产物健康 -> 不算问题，可继续显示 `已安装`

首屏可以包含搜索或过滤，但第一版不要求高级筛选。若插件数量超过屏幕高度，必须支持方向键滚动。

`可升级` 必须是可计算状态，不能只因为插件仍存在于 current catalog 就显示。判定规则：

- 只有 current catalog 可用、插件能从 current catalog 解析，且目标位置有完整 AW 受管安装证据时，才允许显示 `可升级`。
- 受管安装证据至少需要能确认当前安装对应的 `resolvedVersion`，或有可校验的 lifecycle config snapshot / bundle fingerprint。若无法确认已安装版本或 bundle 身份，不显示 `可升级`，转为 `需要处理`，详情页说明 `AW 不能确认当前安装版本，请修复安装或查看诊断。`
- 已安装 `resolvedVersion` / 安装快照 `pluginVersion` 与 current catalog 的 `manifest.version` 不一致，或已安装 bundle fingerprint 与 current catalog bundle fingerprint 不一致时，才显示 `可升级`。
- `catalogCompatibility=capabilityChanged`、Codex native recovery、active-cache-only / enabled-only、artifact drift、最近一次 artifact refresh failed、外部 ownership 冲突、tracking identity 损坏等异常优先级都高于 `可升级`，必须显示为 `需要处理` 或 `部分可用`，详情页给出对应原因码。
- current catalog 缺失或不可读时，不显示 `可升级`。已有安装仍按受管证据显示为 `已安装`、`部分可用` 或 `需要处理`。
- 外部 ownership 需要分流：如果只发现外部来源，且没有 AW 受管证据、runtime evidence 或 native recovery，首屏显示 `由其它来源管理`；如果外部来源和 AW 可管理证据同时存在，首屏显示 `需要处理`，详情页使用 `externalOwnership` 说明冲突。

### 插件详情页

从首屏选择插件后进入详情页。详情页展示：

- 插件名、版本、描述
- 当前友好状态
- 安装位置摘要
- 可执行动作

首屏的同一插件汇总项不能直接承载跨平台、跨位置的写动作。同一插件存在多个位置时，详情页必须先列出位置详情，例如 `Codex（个人）`、`Codex（当前项目）`、`Claude Code（个人）`，再让用户选择明确目标；每个位置单独计算状态、原因码和动作。第一版不做批量操作，`多个位置` 只能作为摘要，不能把 `配置`、`卸载` 或 `升级` 隐式应用到所有位置。

每个位置的动作按当前状态动态展示：

- 未安装：`安装`
- 已安装：`升级`、`配置`、`卸载`
- 可升级：`升级`、`配置`、`卸载`
- 需要处理：展示一条用户可理解的问题说明，并给出可执行修复动作
- 部分可用：展示当前已写入且健康的位置、当前会话不可用或不确定的原因，并提供 `配置`、`卸载`、`查看诊断命令`、`返回`。不要把 `部分可用` 当成安装损坏自动降级为 `需要处理`；除非还有更高优先级的阻断问题，否则不展示 `修复安装`。
- 由其它来源管理：只展示说明和返回，不自动接管

如果 current catalog 缺失、不可读，或当前插件已不在 current catalog 中，详情页不得展示 `升级` 和依赖 schema 的 `配置` 动作。此时可展示 `卸载`、`查看诊断命令`、`返回`，并说明需要恢复插件目录后才能继续配置或升级。`config reset --yes` 仍按脚本化入口的 manifest-optional 分支处理，不属于 TUI schema 配置动作。

详情页需要把底层诊断压缩成稳定的友好原因码，供 TUI 和默认 status 复用。首版至少覆盖：

- `nativeIncomplete`：`Codex 侧已写入，但 AW 未完成收尾。` 动作：`修复安装`，或在存在 recovery breadcrumb 时通过现有 `aw uninstall` 清理这次未收尾安装留下的受控残留。
- `nativeResidue`：`Codex 中发现插件残留，AW 不能确认它是否由当前安装管理。` 动作：只展示说明、`查看诊断命令` 和手动处理建议；第一版不新增 AW cleanup/force 命令，也不把它接到普通 `aw uninstall`，避免误删无归属残留。
- `missingRecord`：`Codex 中已有插件，但 AW 缺少完整安装记录。` 动作：`修复安装`。
- `upgradeEvidenceUnknown`：`AW 不能确认当前安装版本或插件包身份。` 动作：`修复安装`、`查看诊断命令`，不显示 `可升级`。
- `artifactRefreshFailed`：`配置已保存，但相关项目文件刷新失败。` 动作：`重新应用配置`、`查看诊断命令`。
- `artifactDrift`：`已写入的项目文件被修改或缺失。` 动作：`重新安装/升级` 或 `卸载`。
- `projectVisibilityBlocked`：`项目文件已写入，但当前 Codex 会话还不能使用它，或 AW 暂时不能确认当前仓库信任状态。` 动作：提示信任当前仓库、重新打开会话或查看诊断，不把磁盘健康状态误报成缺失。
- `sessionVisibilityLimited`：`插件已写入，但当前 Codex 会话可能没有使用这份内容。` 动作：提示检查当前仓库的项目级指令、同名高优先级配置或查看诊断；状态归入 `部分可用`，不把磁盘健康状态误报成缺失。
- `externalOwnership`：`同名插件已由其它来源管理。` 动作：纯外部来源只展示说明和返回；如果外部来源和 AW 可管理证据冲突，提示用户先解除同名外部占用或查看诊断命令，不自动接管。
- `requiredConfigMissing`：`这个插件还缺少必填配置。` 动作：`配置`、`查看诊断命令`。
- `invalidConfig`：`已保存的配置无效或引用的路径不可用。` 动作：`配置`、`查看诊断命令`。
- `unreadableConfig`：`AW 无法读取当前配置文件。` 动作：提示用户修复配置文件或运行诊断命令；TUI 不自动改写不可读文件。
- `trackingIdentityBroken`：`AW 的项目文件记录不完整，无法安全确认要管理的内容。` 动作：`查看诊断命令`；不自动编造身份、不自动清理。
- `roleOrMcpConflict`：`当前项目里已有同名 Codex 角色或 MCP 配置，AW 不能确认归属。` 动作：只展示说明和诊断命令，不自动覆盖。
- `unmanagedArtifactConflict`：`当前项目里已有同名项目文件或配置片段，但不属于 AW 管理。` 动作：只展示说明和诊断命令，不自动接管或删除。
- `catalogCapabilityChanged`：`插件当前版本的项目能力和已安装记录不一致。` 动作：`重新安装/升级`、`查看诊断命令`。
- `catalogUnavailable`：`当前插件目录不可用，AW 无法读取这个插件的配置和升级信息。` 动作：`卸载`、`查看诊断命令`、`返回`；不展示 `升级` 或 schema 配置动作。

详情页必须有 `返回`，破坏性操作必须二次确认。

`artifactRefreshFailed` 的 `重新应用配置` 是独立动作，不等同于重新打开配置表单并保存现有值。它必须在不修改 config store 的前提下，基于 tracking 中失败 artifact 的 `refreshKeys`，或当前目标全部 tracked refresh keys，重跑一次 dynamic artifact refresh。这个动作的 JSON receipt 仍使用稳定 `artifactRefresh` 字段；成功时更新对应 artifact 的 `lastRefresh` 和 tracking 诊断，失败时保留原配置，并写入本次失败的 `artifactRefresh.error`，供 `aw status --verbose` 和 `status --json` 继续诊断。若目标位置没有可定位的 tracked dynamic artifact，动作必须返回 skipped，并在 TUI 中说明“没有需要重新应用的项目文件”。

### 安装向导

安装动作在 TUI 内完成必要选择：

- 平台：Codex、Claude Code，必要时可选两者，但第一版不做批量插件。
- 位置：个人、当前项目。
- 触发方式：只在插件确实需要且允许覆盖时出现；文案使用 `默认`、`手动`、`自动`。
- 必填配置：按 manifest config schema 生成表单。
- dynamic artifact 插件的配置项仍按普通 manifest config schema 展示；TUI 不需要暴露 renderer、refresh key 或 artifact plan。

如果某个组合不可安装，显示用户能理解的原因，例如：

- `这个插件不能安装到当前项目，请改为安装到个人位置。`
- `Codex 当前不可用，但此插件可以写入当前项目文件。`
- `同名插件已由其它来源管理，请先处理冲突。`

### 配置向导

配置表单使用 schema 信息生成：

- `string` / `file` / `directory` 用输入框。
- `number` 用输入框并校验范围。
- `boolean` 用确认开关。
- `enum` 用选择框。
- `sensitive` 值隐藏输入，已配置时只显示 `已配置`。

写入位置默认跟当前安装位置一致；如果插件尚未安装，默认写入 `个人`，但允许选择 `当前项目`。

配置保存后必须复用脚本化 `config set` / `unset` / `reset` 的 refresh 语义：

- 命中已安装 dynamic artifact 的刷新键时，自动刷新当前可定位目标。
- 刷新成功时只展示简短结果，例如 `配置已保存，相关项目文件已刷新。`
- 刷新失败时保留配置，并展示用户能行动的说明，例如 `配置已保存，但相关项目文件刷新失败。请重新应用配置或运行 aw status --verbose 查看诊断。`
- TUI 不展示 `artifactRefresh`、`refreshKeys`、digest 或 tracking 字段。

TUI 配置表单是多字段一次提交，内部必须使用共享写入 helper，而不是循环调用 `config set`：

- 抽出 `writePluginConfigUpdates()` / `applyConfigWizardUpdates()` 这类共享 helper，供 `config set`、`config unset`、`config reset --yes` 和 TUI 配置向导复用校验、store patch、effective config 重算和 artifact refresh 逻辑。
- TUI 保存前必须先整体校验所有字段。任一字段不合法时，不写 config store，也不触发 artifact refresh。
- 多字段保存必须一次 patch 目标 store，并只触发一次 artifact refresh。`updatedKeys`、`removedKeys` 和 `artifactRefresh.triggerKeys` 必须描述同一轮表单提交。
- 如果 store 写入成功但 refresh 失败，保留配置，返回 refresh failed receipt；不能回滚已保存配置，也不能继续执行第二条隐藏 refresh 路径。
- 切换写入位置时，只写本次显式修改的 key，不把另一层 effective config 中已有但未修改的值复制到目标 store，尤其不能复制 sensitive 值。
- 共享 helper 必须保留 `config reset --yes` 的 manifest-optional 分支。`config set`、`config unset` 和 TUI 配置向导仍必须读取 current catalog schema 后才能校验和写入；但 `config reset <plugin> -s <scope> --yes` 是 store 级清理，即使 current catalog 已找不到该插件，只要插件名是安全路径片段，也要删除目标 config store，返回 JSON receipt，并把 `artifactRefresh` 标记为 `skipped`。这种分支不重算 effective config，也不尝试运行 artifact refresh。

### 完成反馈

TUI 动作完成后只显示简短结果：

- `git-commit 已安装到 Codex（个人）。`
- `git-commit 已升级。`
- `git-commit 已从当前项目移除。`
- `配置已保存。`
- `配置已保存，相关项目文件已刷新。`

如果有需要用户处理的问题，用 `注意` 或 `下一步` 表达，不输出内部诊断字段。

## 子命令行为

### 删除交互入口

以下入口从 help、解析和文档中移除：

- `install -i/--interactive`
- `install --no-interactive`
- `uninstall -i/--interactive`
- `uninstall --no-interactive`
- `upgrade -i/--interactive`
- `upgrade --no-interactive`
- `config configure`
- `config reset -i/--interactive`
- `config reset --no-interactive`

旧命令直接变成 unknown option/unknown command，不再保留兼容报错。

### 非交互合同

- `aw install` 没有插件名时直接失败，提示运行 `aw` 进入交互控制台，或运行 `aw install <plugin>`。
- `aw uninstall` 没有插件名时直接失败，提示运行 `aw` 或 `aw uninstall <plugin>`。
- `aw upgrade` 没有插件名且没有 `--all` 时直接失败，提示运行 `aw` 或 `aw upgrade <plugin>` / `aw upgrade --all`。
- `config reset` 遇到已有配置时必须显式传 `--yes`，不再 prompt。
- 安装/升级遇到缺少必填配置时，子命令必须失败并给出 `aw config set ...` 或 `aw` 主入口的下一步，不再在子命令中补问。
- `config set`、`config unset`、`config reset --yes` 是保留的脚本化配置写入口；如果命中 dynamic artifact refresh，命令可以执行刷新，但不得进入 prompt。
- `config configure` 直接移除。`codex-explore` 等依赖配置向导的使用场景改为通过 `aw` 主入口完成。

### JSON receipt

所有子命令支持 `--json`。成功时 stdout 只能是一份 JSON；失败时 stderr 输出错误，人类 warning 不得混入 JSON stdout。

除 `status --json` 的兼容矩阵例外外，写命令和其它非 status 子命令的最小公共结构：

```json
{
  "ok": true,
  "command": "install",
  "warnings": [],
  "nextSteps": []
}
```

`status --json` 不使用 `{ ok, command, matrix }` 这类包裹结构，避免破坏现有调用方读取 `detection`、`summaries`、`cells`、`reports`。它必须继续以当前 `StatusMatrixReport` 字段为顶层，并只追加兼容字段，例如：

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

旧调用方按矩阵字段读取仍应成功；新调用方可以读取 `ok`、`command`、`friendlySummaries` 和 `consoleItems`。

写命令还应包含：

- `plugins`
- `targets`：平台和位置使用稳定字段 `platform`、`scope`，这是 JSON API，可保留技术字段
- `actions`：安装、升级、卸载、配置写入、native 写入、修复或清理等结构化结果
- `skipped`：升级跳过项
- `artifacts`：只包含稳定路径、kind、id、target、state、roleKey 等机器字段，不要求给人类阅读
- `native`：Codex user native 写路径的机器结果，例如 enabled/config/cache/post-check/recovery 状态；这些字段不进入默认成功文案
- `artifactRefresh`：配置写命令的 refresh receipt，保留 `attempted`、`status`、`triggerKeys`、`artifacts[]` 和可诊断 `error`

`status --json` 保持当前基线的矩阵结构可解析，但不能再假定 `native.pluginInstalled` 等同于 enabled config。当前基线中：

- `native.pluginInstalled` 表示 Codex active cache 已存在。
- `native.pluginEnabled` 表示用户级 config 中插件已启用。
- `native.recovery` 固定表达 native recovery 状态。
- dynamic artifact 的健康、会话可见性和 refresh metadata 继续保留为机器字段。

可以新增 `friendlySummaries` / `consoleItems` 字段服务新 UI，但不得破坏当前 JSON 可解析性。旧语义迁移需要在文档里明确说明。

### 默认人类输出

写命令默认输出要比当前 receipt 更短。示例：

```text
git-commit 已安装到 Codex（个人）。
下一步：运行 aw 查看和管理插件。
```

如果是当前项目安装：

```text
skills-mcp 已安装到 Codex（当前项目）。
已写入项目文件：.agents/skills、.codex/config.toml。
```

不再默认输出：

- `使用插件目录`
- `已复用本地 marketplace`
- `已确认 Codex marketplace 注册`
- `已确认插件启用`
- `已通过 Codex app-server 完成原生插件安装`
- `active cache` / `enabled config` / recovery breadcrumb
- `healthSource`
- `config`
- `scripts`
- 安装记录内部状态

这些信息可以进入 debug log、JSON 或 `--verbose`。

## `aw status` 友好摘要

默认 `aw status` 输出应回答三个问题：

1. 装了哪些插件？
2. 它们能不能用？
3. 用户下一步应该做什么？

推荐形态：

```text
插件状态
git-commit      已安装       Codex（个人）
skills-mcp      需要处理     Codex（当前项目）

下一步
- skills-mcp：当前项目配置不完整，运行 aw 打开控制台完成配置。
```

默认输出不展示每个 platform/scope 的底层状态点。用户传 `--verbose` 时，可以继续输出诊断矩阵，但应把它放在 `诊断信息` 小节，并接受内部术语。

默认 status 中遇到新基线状态时，使用友好原因，不输出内部证据名：

- Codex user native recovery：`Codex 侧已写入，但 AW 未完成收尾。`
- enabled-only / cache-only：`Codex 中发现未完整的插件状态。`
- dynamic artifact refresh failed：`配置已保存，但相关项目文件刷新失败。`
- project trust / visibility：`项目文件已写入，但当前会话可能还不能使用。`

对应下一步统一指向 `aw` 主入口、明确的 `aw install <plugin> -p codex -s user` 修复命令、可证明安全的 `aw uninstall ...` 清理命令，或 `aw status --verbose` 诊断命令。对于无归属 `nativeResidue`，默认 status 只能提示查看诊断和手动确认来源，不能给出 AW 自动清理命令。

## 内部设计要求

### 新增友好状态投影层

在 `commands/status.ts` / `commands/discovery.ts` 之上新增友好投影，不直接把 `StatusMatrixCell` 渲染给默认人类输出或 TUI。

建议结构：

```ts
type PluginConsoleActionKind =
  | 'openInstallWizard'
  | 'openConfigWizard'
  | 'runInstall'
  | 'runUpgrade'
  | 'runUninstall'
  | 'repairInstall'
  | 'cleanupRecovery'
  | 'reapplyConfigRefresh'
  | 'diagnoseCommand'
  | 'back';

interface PluginConsoleActionTarget {
  platform: 'codex' | 'claude';
  scope: 'user' | 'project';
  projectKey?: string;
}

interface PluginConsoleAction {
  kind: PluginConsoleActionKind;
  label: string;
  target?: PluginConsoleActionTarget;
  destructive?: boolean;
  confirmText?: string;
  disabledReason?: string;
  command?: string[];
}

interface PluginConsoleLocation {
  platform: 'codex' | 'claude';
  scope: 'user' | 'project';
  projectKey?: string;
  locationLabel: string;
  status: PluginConsoleItem['status'];
  statusLabel: string;
  actions: PluginConsoleAction[];
  reasonCodes: PluginConsoleReasonCode[];
  issueSummary?: string;
  detailHints?: string[];
}

type PluginConsoleReasonCode =
  | 'nativeIncomplete'
  | 'nativeResidue'
  | 'missingRecord'
  | 'upgradeEvidenceUnknown'
  | 'artifactRefreshFailed'
  | 'artifactDrift'
  | 'projectVisibilityBlocked'
  | 'sessionVisibilityLimited'
  | 'externalOwnership'
  | 'requiredConfigMissing'
  | 'invalidConfig'
  | 'unreadableConfig'
  | 'trackingIdentityBroken'
  | 'roleOrMcpConflict'
  | 'unmanagedArtifactConflict'
  | 'catalogCapabilityChanged'
  | 'catalogUnavailable';

interface PluginConsoleItem {
  pluginName: string;
  title: string;
  description?: string;
  version?: string;
  status: 'notInstalled' | 'installed' | 'upgradeAvailable' | 'needsAction' | 'partial' | 'external';
  statusLabel: string;
  locationSummary: string;
  actions: PluginConsoleAction[];
  locations: PluginConsoleLocation[];
  blockingMessage?: string;
  reasonCodes: PluginConsoleReasonCode[];
  issueSummary?: string;
  detailHints?: string[];
}
```

底层仍可保留 `StatusMatrixReport` 给 JSON、verbose 和测试使用。友好投影层负责把以下内部来源收敛成同一个 `PluginConsoleItem`：

- current catalog
- ledger / tracking
- Codex enabled config / active cache / native recovery
- Claude settings / installed plugins evidence
- dynamic artifact health、last refresh 和 session visibility

同一插件跨平台或跨位置时，首屏只显示一个 item；详情页再列出 `locations[]` 中的 `Codex（个人）`、`Codex（当前项目）`、`Claude Code（个人）` 等友好位置。`PluginConsoleItem.actions` 只允许放不需要目标或已经唯一确定目标的安全动作，例如 `back`、`diagnoseCommand`、只有一个位置时的 `openInstallWizard`；涉及写入的动作必须来自 `PluginConsoleLocation.actions`，并带上明确的 `platform`、`scope` 和 `projectKey`。

动作合同必须区分“打开向导”和“立即写状态”：

- `openInstallWizard` / `openConfigWizard` 只打开 TUI 向导，不直接写入状态；如果进入向导前已经唯一确定位置，可以带 `target` 作为默认值，否则向导必须继续让用户选择平台和位置。
- `runInstall` / `runUpgrade` / `runUninstall` 是已经绑定目标的写动作，必须带 `target`，并转换成对应非交互命令 API 调用。
- `repairInstall` 复用现有 install/upgrade 安全预检和写入语义，必须带 `target`，不能绕过 native post-check、tracking identity 或外部 ownership 检查。
- `cleanupRecovery` 只用于存在 native recovery breadcrumb 且证据匹配的受控残留清理，必须带 `target`，并复用现有 uninstall recovery 语义；无归属 `nativeResidue` 不能生成这个动作。
- `reapplyConfigRefresh` 只重跑 dynamic artifact refresh，不修改 config store，必须带 `target`。
- `diagnoseCommand` 只提供可复制命令，不写状态；`command` 使用 argv 数组，方便 TUI 展示和 JSON 调用方复用。
- 所有会删除、覆盖或清理状态的动作必须设置 `destructive: true` 和明确 `confirmText`。当前状态下不可执行但需要展示占位说明的动作必须设置 `disabledReason`，TUI 不能靠中文 `label` 反推行为。

友好投影层必须集中定义状态优先级，供 TUI、默认 `aw status` 和 `status --json.consoleItems` 复用。建议优先级为：

1. 外部来源和 AW 受管证据、runtime evidence 或 native recovery 同时存在 -> `needsAction`，原因码为 `externalOwnership`。
2. `trackingIdentityBroken`、`nativeIncomplete`、`unreadableConfig`、`roleOrMcpConflict`、`unmanagedArtifactConflict`、`catalogCapabilityChanged` 等阻断性问题 -> `needsAction`。
3. dynamic artifact refresh failed / drift / missing，或配置缺失导致产物不可刷新 -> `needsAction`。
4. project trust / session visibility 导致磁盘文件健康但当前会话可能不可用 -> `partial`。
5. current catalog 可用且完整受管安装证据显示版本或 bundle 与 current catalog 不一致 -> `upgradeAvailable`。
6. 完整受管证据健康 -> `installed`。
7. 只有外部来源、没有 AW 受管证据、runtime evidence 或 native recovery -> `external`。
8. 只有 current catalog、没有安装或 runtime evidence -> `notInstalled`。

同一插件有多个位置时，任一位置存在 `needsAction` 应让首屏显示 `需要处理`；仅部分位置可用且没有更高优先级问题时显示 `部分可用`；`可升级` 只在所有已安装位置都没有更高优先级问题时出现。

session visibility 必须完整映射，不能只处理 project trust：

- `blockedByProjectTrust` 和 `projectTrustUnknown` 映射为 `partial` + `projectVisibilityBlocked`，说明项目文件已写入但当前会话可见性受仓库信任状态影响。
- `shadowedByProjectDeveloperInstructions` 映射为 `partial` + `sessionVisibilityLimited`，说明个人位置已写入但当前仓库的项目级 developer instructions 会优先生效。
- `unknownByExternalLayer` 映射为 `partial` + `sessionVisibilityLimited`，说明 AW 发现可能有更高优先级的同名配置，不能保证当前会话正在使用这份内容。
- 以上状态只能影响友好投影和下一步建议；底层 `status --json` 仍保留原始 `sessionVisibility` 机器字段，`--verbose` 可展示原始诊断。

### TUI 控制器

新增主入口控制器，例如 `commands/console.ts` 或 `commands/dashboard.ts`：

- 负责加载 console items。
- 负责调用 `@inquirer/prompts`。
- 负责把用户选择转换成现有非交互 command API 调用。
- 不在 adapter 层直接 prompt。
- 不绕过现有 install/uninstall/upgrade/config 的安全预检。
- 配置向导完成后复用现有 config 写入和 artifact refresh helper，不新增另一条 refresh 路径。
- Codex native repair / recovery cleanup 动作必须调用现有 install/uninstall 命令语义，不能绕过 recovery breadcrumb 授权和 post-check。无归属 `nativeResidue` 第一版没有 AW cleanup/force 动作，只能展示诊断和手动处理说明。

安装/升级向导必须先执行不会写状态的安全预检，再进入必填配置表单。顺序要求：

1. 解析目标平台和位置，确认插件在该组合下可安装。
2. 执行 Codex project write safety、用户级 Codex config 可读性、project Codex config 可读性、external ownership、tracking identity、role/MCP 冲突和未受管 repo artifact 冲突等预检。
3. 只有安全预检全部通过后，才展示 required config 表单或写入 config store。
4. mixed target 安装/升级通过安全预检后，同一插件只展示一次 required config 表单，并让后续 Codex / Claude 写入复用重新解析后的 effective config。

安全预检失败时，TUI 必须直接展示可理解的失败说明，不调用配置向导、不创建 user/project config store，也不写 native state、repo-managed artifacts、tracking 或 ledger。

当前 [commands/interactive.ts](../../../../packages/cli/src/commands/interactive.ts) 可以删除，或只保留测试辅助逻辑；CLI 子命令不再调用它。

### Prompt 抽象

保留可注入 prompt/TUI 适配层，保证测试不依赖真实终端。默认实现使用 `@inquirer/prompts`。

至少需要：

- 单选
- 确认
- 文本输入
- 密码/隐藏输入
- 可滚动列表
- 返回/取消语义

第一版不要求 checkbox 多选，因为不做批量。

### 输出分层

输出必须分成三层：

- 友好人类输出：默认 stdout/TUI。
- 诊断输出：`--verbose` 和 debug log。
- 机器输出：`--json`。

warning 需要有分类，默认只显示用户可行动的 warning。内部诊断 warning 进入 debug log 或 verbose，不再通过 `formatWarnings()` 直接泄露给默认输出。

## 测试验收

### TUI

- 注入 fake prompt 时，`runCli([])` 能进入插件控制台流程并完成安装。
- 非 TTY/CI 下 `runCli([])` 不挂起，返回清晰错误和示例。
- 首屏候选来自 current catalog + 已安装/可发现插件，包括 Codex native config、active cache、native recovery breadcrumb、tracking dynamic artifact。
- 首屏同名插件跨平台/位置时只显示一个简化汇总项。
- 首屏同名插件跨平台/位置时，详情页会展示 location-level 状态和动作；`多个位置` 摘要不会触发隐式批量配置、卸载或升级。
- 详情页动作会按状态变化，例如未安装只显示安装，已安装显示升级/配置/卸载。
- 同名插件只由外部来源管理时显示 `由其它来源管理`；外部来源和 AW 受管证据冲突时显示 `需要处理`，并给出 `externalOwnership` 原因码。
- current catalog 缺失、不可读或插件已不在 current catalog 中时，不显示 `可升级`，详情页也不展示 `升级` 或 schema 配置动作，只展示可执行的卸载、诊断和返回动作。
- Codex user native recovery 显示为 `需要处理`，详情页给出修复安装和受控清理残留动作。
- Codex native fallback/cache-only 这类无归属 `nativeResidue` 显示为 `需要处理`，详情页只给出说明、诊断命令和手动处理建议，不展示 AW 自动清理动作。
- enabled-only、cache-only、breadcrumb-only 不会被显示成 `已安装`。
- dynamic artifact refresh failed / drift / missing 显示为 `需要处理`，disabled by config 不算问题。
- `artifactRefreshFailed` 的位置详情包含 `reapplyConfigRefresh` 动作；选择后即使没有新的 config key 变更，也会基于 tracked refresh keys 重跑 refresh，并返回稳定 `artifactRefresh` receipt。
- project scope 文件健康但会话可见性受 trust 或 session visibility 影响且没有更高优先级问题时显示为 `部分可用`，不会误报成 `需要处理`，详情页解释原因并展示 `配置`、`卸载`、`查看诊断命令`、`返回`。
- Codex user scope 文件健康但当前仓库会话出现 `shadowedByProjectDeveloperInstructions` 或 `unknownByExternalLayer` 时显示为 `部分可用`，reasonCodes 包含 `sessionVisibilityLimited`，默认输出用友好说明解释当前会话可能没有使用这份内容。
- `blockedByProjectTrust`、`projectTrustUnknown`、`shadowedByProjectDeveloperInstructions`、`unknownByExternalLayer` 四种 session visibility 都有 `status --json.consoleItems` 覆盖，且不会被默认输出降噪成普通 `已安装`。
- 无法确认已安装版本或 bundle 身份、tracking identity 损坏、配置不可读、role/MCP 冲突、未受管 repo artifact 冲突、catalog capability changed、catalog unavailable 都会映射到稳定 `reasonCodes`，TUI、默认 `aw status` 和 `status --json.consoleItems` 使用同一套友好说明。
- `status --json.consoleItems[].locations[].actions[]` 覆盖 `kind`、`label`、`target`、`destructive`、`confirmText`、`disabledReason` 和 `command` 字段，测试不能只断言中文按钮文案。
- 安装向导能选择平台、位置、触发方式和必填配置。
- 配置向导写入命中 refresh key 的配置后会触发 refresh；成功、失败和 skipped 都有测试覆盖。
- Codex project 安全预检失败时，TUI 不调用 required config 表单，不创建 user/project config store，也不写 native state、repo-managed artifacts、tracking 或 ledger。
- 安全预检失败路径至少覆盖用户级 Codex config 不可读、project Codex config 不可读、外部 ownership、tracking identity 损坏、role/MCP 冲突和未受管 repo artifact 冲突。
- mixed target 安装/升级在安全预检通过后，同一插件只提示一次 required config；写入后 Codex 和 Claude 都复用同一份 effective config。
- 破坏性卸载必须确认；取消后不写状态。

### 子命令

- `aw install --interactive`、`aw install --no-interactive` 返回 unknown option。
- `aw uninstall --interactive`、`aw uninstall --no-interactive` 返回 unknown option。
- `aw upgrade --interactive`、`aw upgrade --no-interactive` 返回 unknown option。
- `aw config configure` 返回 unknown command。
- `aw config reset <plugin> --interactive`、`aw config reset <plugin> --no-interactive` 返回 unknown option。
- `aw config reset <plugin>` 在需要确认时失败并提示 `--yes`，不会 prompt。
- `aw install`、`aw uninstall`、`aw upgrade` 缺少必要参数时失败并提示运行 `aw` 主入口。
- 子命令不会调用 prompt，即使 runtime 注入了 fake prompt。
- `aw config set/unset/reset --json` 命中 dynamic artifact refresh 时，stdout 仍是单一 JSON，并包含稳定 `artifactRefresh`。
- `aw config reset <stale-plugin> -s user --yes --json` 在 current catalog 已无该插件但 config store 存在时仍会删除 store，stdout 是单一 JSON，`artifactRefresh.status` 为 `skipped`，不会因为缺少 manifest schema 而失败。

### 输出

- 成功安装默认输出不包含 `marketplace`、`app-server`、RPC、cache、recovery breadcrumb、`账本`、`degraded`、`healthSource`、`config=no-schema`、`scripts=not_declared`、`repo-managed`。
- `aw status` 默认输出不包含上述内部词，也不直接输出 `pluginEnabled`、`pluginInstalled`、`artifactRefresh`、`refreshKeys`、`configDigest`、`contentDigest`、`sessionVisibility`、`projectTrust`。
- 默认人类输出和 TUI 的 prose 不出现 `user scope`、`project scope` 或裸 `scope`。可复制命令、argv 数组、flag 名、JSON 字段和代码类型示例可以保留 `--scope` / `scope`，测试需要把这些技术片段作为例外处理。
- `aw status --verbose` 可以包含诊断字段。
- 所有 `--json` stdout 都能 `JSON.parse`，stderr 不影响 stdout。
- `install/uninstall/upgrade/init/config/status --json` 都有稳定 `ok`、`command` 字段。
- `status --json` 覆盖 `native.pluginInstalled` 作为 active cache、`native.pluginEnabled` 作为 enabled config，以及 `native.recovery.present/state/reason/evidenceMatches/suggestion`。
- `status --json` 覆盖 dynamic artifact health、session visibility 和 refresh metadata；默认 status 只展示友好投影。

### 回归安全

- Codex project scope 安装仍不要求 native Codex runner。
- Codex user scope 继续走 app-server RPC 和 post-check；project scope 仍只写当前项目文件，不产生用户级 native 副作用。
- Codex user scope 和 Claude native runtime 仍按需同步 `~/.aw`。
- 外部 marketplace ownership 仍会阻断危险写入。
- required config 在子命令中失败，在 TUI 中走向导。
- rollback/degraded 写入语义保留，但默认文案不暴露内部状态名。
- `status` 仍保持只读，不为读取状态创建、同步或修复 `~/.aw`。
- `status` 仍不执行 artifact renderer、lifecycle 或 app-server。

## 文档更新要求

实现本 spec 时必须同步更新：

- `README.md`
- `docs/plugin-installation.md`
- `docs/architecture.md`
- `docs/testing.md`

需要删除旧交互模式说明，新增：

- `aw` 主入口控制台说明
- 子命令非交互合同
- JSON receipt 合同
- 默认输出与 verbose/debug/json 的边界
- Codex user native 的 enabled config / active cache / recovery 语义
- dynamic artifact、配置触发 refresh 和默认输出友好投影边界

按仓库维护原则，如果插件作者技能、模板或示例中提到 `aw config configure`、`--interactive`、`--no-interactive` 或旧安装体验，也必须同步检查 `.agents/skills/create-agent-workflows-plugin/` 并更新。
`docs/dev/plans/codex-explorer-plugin.md` 中仍提到 `aw config configure` 作为 refresh 写入口，实施本 spec 时也要同步改成“主入口配置向导 + `config set/unset/reset` 脚本化入口”。

## 实施风险

- 这是 breaking change：旧的交互 flag 和 `config configure` 会直接消失。
- 新依赖需要确认能通过项目实际 registry 安装、打包和 smoke test。
- TUI 必须有可注入抽象，否则测试会变脆。
- 默认输出变短后，诊断信息必须能在 `--verbose`、`--debug` 和 JSON 中找回。
- JSON receipt 一旦发布就要稳定，字段命名需要在实现前再做一次 schema review。
- 旧文档和作者工具大量提到 `config configure`、`--interactive`、`--no-interactive`；删除入口时必须一次性同步，否则用户会看到互相冲突的说明。
- 新基线状态很多，如果友好原因码没有集中定义，默认 status、TUI、JSON friendly summaries 容易各说各话。
