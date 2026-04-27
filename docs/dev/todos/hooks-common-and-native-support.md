# Hooks 公共层与原生能力 TODO 拆解

## 文档说明

- 来源计划：`docs/dev/plans/hooks-common-and-native-support.md`
- 目标：把 hooks 公共层与 `extensions.nativeHooks` 改造拆成可以独立推进、独立验收的阶段任务。
- 使用方式：每个阶段都先完成开发项，再补自动化测试，最后通过阶段验收；阶段验收不过，不进入下一阶段。
- 统一约束：
  - 所有命令默认在 repo root 执行。
  - 公共 `extensions.hooks` 只保留 `before_tool`、`after_tool`、`session_start`。
  - `session_stop` 不再是公共 `HookEvent`，Claude / Codex 的 stop 类事件统一走 `extensions.nativeHooks.<agent>`。
  - `extensions.nativeHooks` 只允许 `claude` 和 `codex` 两个 key，事件名使用平台原生名。
  - Source manifest 和 CLI 生成物使用 strict contract；读取现有 Codex shared `.codex/hooks.json` 使用 shared read/write contract。
  - Codex shared hooks 的所有权单位是 raw matcher group，不按 handler 粒度拆分、认领或扣减。
  - Claude 首版不新增 `kind: "hook"` tracking artifact；Codex 首版不凭 `hasRepoManagedArtifacts` 从 ledger-only 场景合成 hook placeholder。

## 阶段总览

| 阶段 | 对应计划 | 目标 | 阶段门禁 |
|------|------|------|------|
| 阶段 1 | 实现计划 1 + 2 | 冻结 source contract、类型、allowlist、matcher 能力和 manifest 校验 | source manifest 能准确接受 / 拒绝公共 hooks 与 native hooks |
| 阶段 2 | 实现计划 3 + 4 | 打通 hooks generator、rendered contract 和 Codex shared read/write parser | Claude / Codex artifact 能同时渲染公共与 native hooks，shared parser 不误伤外部 groups |
| 阶段 3 | 实现计划 5 前半 | 接入 bundle source manifest、embedded catalog 与 Claude bundle 生成 | `nativeHooks` 能从 source 穿过 bundle source manifest 并被 catalog 读回 |
| 阶段 4 | 实现计划 5 Codex 主链路 | 改造 Codex shared hooks install / upgrade / uninstall / tracking 写回 | Codex shared hooks 写回只替换本次可重渲染 AW groups，保留历史 AW raw groups 和 foreign groups |
| 阶段 5 | 实现计划 6 | 收口 status / drift / historical fallback 与 Claude capability snapshot | 两端状态面按正确信息源识别 hook 能力和 expected groups |
| 阶段 6 | 实现计划 7 | 更新作者工具、参考文档和用户文档 | 作者工具与文档示例全部对齐新 contract |
| 阶段 7 | 实现计划 8 | 补齐命令级集成回归与最终 smoke | `nativeHooks` 主链路通过 unit、integration、build 和 smoke 验收 |

## 阶段 1：source contract、类型与 manifest 校验

### 目标

先把“插件作者可以写什么”定死：公共 hooks 收窄，native hooks 入场，事件 allowlist 和 matcher 能力表集中维护，并让 source validator 在入口处给出准确错误。

### 开发 TODO

- [x] 新建或整理 `packages/cli/src/utils/hooks-contract.ts`。
- [x] 定义 `PUBLIC_HOOK_EVENTS`，只包含 `before_tool`、`after_tool`、`session_start`。
- [x] 定义 `PUBLIC_SESSION_START_SOURCES`，只包含 `startup`、`resume`、`clear`。
- [x] 定义 `PUBLIC_HOOK_EVENT_RENDER_MAP`，只维护 3 个公共事件在 Claude / Codex 上的映射。
- [x] 定义 `CLAUDE_NATIVE_HOOK_EVENTS`，完整列出 2026-04-27 复核的 Claude `HOOK_EVENTS` 集合。
- [x] 定义 `CODEX_NATIVE_HOOK_EVENTS`，包含 `PreToolUse`、`PermissionRequest`、`PostToolUse`、`SessionStart`、`UserPromptSubmit`、`Stop`。
- [x] 定义 `NATIVE_HOOK_EVENT_CONTRACTS` 或同等结构，覆盖每个平台每个原生事件的 matcher 能力。
- [x] 在代码注释中标明 Claude allowlist 来源文件、matcher 能力来源文件和核对日期。
- [x] 为 Claude `FileChanged` matcher 特例写清楚 runtime 来源。
- [x] 实现 `renderPublicHookEvent(event, platform)`。
- [x] 实现 `assertNativeHookEvent(event, platform, fieldName)`。
- [x] 实现 `assertHookMatcherAllowed(...)`，同时覆盖公共事件和 native 事件。
- [x] 实现 `normalizeRenderedHookGroupIdentity(...)`，作为重复检测、tracking、status 的唯一 canonical identity 入口。
- [x] 在 `packages/cli/src/types.ts` 新增 `NativeHookDefinition`、`NativeHooksByPlatform`、`RenderedHookGroup`、`TrackedHookGroupIdentity`、`CodexSharedHookGroup` 或同等类型。
- [x] 给 `PluginExtensions` 增加 `nativeHooks?: NativeHooksByPlatform`。
- [x] 保持 `HookDefinition` 只表示公共 hooks，不把 native event 混进 `HookEvent`。
- [x] 从 `HookEvent` 中移除 `session_stop`，同步清理旧 fixture、断言和示例里的公共 `session_stop`。
- [x] 拆开 Codex rendered hook group 与 tracking identity 类型，停止用 `CodexHookGroup.matcher` 兼任两种语义。
- [x] 更新 `packages/cli/src/utils/manifest.ts`，source 校验阶段拒绝公共 `event: "session_stop"`。
- [x] 校验公共 `session_start.matcher`：只允许省略、`startup`、`resume`、`clear` 或这些值的 `|` 联合。
- [x] 在 `agentOverrides.<platform>` 改写公共 hook 后重新校验事件和 matcher。
- [x] 校验 `extensions.nativeHooks` 的对象形状，只允许 `claude` / `codex`。
- [x] 校验 `nativeHooks.<agent>[]` 的 `event` 必须在对应平台 allowlist 内。
- [x] 校验 native hook 的 `command` 与公共 hook 规则一致。
- [x] 对 matcherless native 事件直接拒绝 `matcher` 字段。
- [x] 拒绝 `nativeHooks.*[].agentOverrides`、`description` 等非 contract 字段。
- [x] 在同一目标平台最终生效视图里检查公共 hook 与 native hook 的 canonical 重复。
- [x] 确保公共 `session_start` 未写 matcher 时的 `effectiveMatcher` 固定为 `startup|resume|clear`。

### 自动化测试

- [x] 更新 `packages/cli/tests/unit/manifest.test.ts`，接受合法 `nativeHooks.claude` / `nativeHooks.codex`。
- [x] 覆盖未知 `nativeHooks` agent key 的拒绝用例。
- [x] 覆盖目标平台不支持的原生事件拒绝用例。
- [x] 覆盖完整 Claude native allowlist 中每个事件的接受用例。
- [x] 覆盖 Claude matcher 能力表：允许 matcher 的事件通过，拒绝 matcher 的事件报错。
- [x] 覆盖 Codex matcherless 事件 `UserPromptSubmit` / `Stop` 携带 matcher 的拒绝用例。
- [x] 覆盖 native hook 中 `agentOverrides`、`description` 等非法字段的拒绝用例。
- [x] 覆盖公共 `event: "session_stop"` 和 `agentOverrides.<platform>.event = "session_stop"` 的拒绝用例。
- [x] 覆盖公共 `session_start.matcher = "compact"`、`"*"` 和会匹配 compact 的正则被拒绝。
- [x] 覆盖公共 `session_start.matcher = "startup"`、`"resume"`、`"clear"`、`"startup|resume|clear"` 被接受。
- [x] 覆盖同一目标平台公共 + native canonical 重复 hook 被拒绝。
- [x] 新建或更新 `packages/cli/tests/unit/hooks-contract.test.ts`，锁住 Claude allowlist 完整快照。
- [x] 断言 `NATIVE_HOOK_EVENT_CONTRACTS.claude` 对完整 Claude allowlist 没有 missing / extra event。
- [x] 断言 Claude matcher / matcherless 两组事件互斥且并集等于完整 allowlist。
- [x] 单独断言 `FileChanged` 允许 matcher。
- [x] 运行 `pnpm test:unit`。

### 阶段验收

- [x] Source manifest 明确拒绝公共 `session_stop`，错误信息指向对应平台的 native stop 事件。
- [x] 公共 `session_start` 只表达 `startup / resume / clear`，不会把 Claude `compact` 纳入公共层。
- [x] `nativeHooks` 入口、平台 key、事件 allowlist、matcher 能力和非法字段都有入口校验。
- [x] Claude allowlist 与 2026-04-27 计划中列出的完整事件集合一致，测试不是只覆盖代表事件。
- [x] Codex matcherless 事件从 source 层开始不依赖 `matcher: ""` 或 `matcher: "*"` 伪装。

## 阶段 2：generator、rendered contract 与 Codex shared parser

### 目标

让公共 hooks 和目标平台 native hooks 能合并渲染成同一份原生 artifact，同时把 CLI 自己生成的 strict 校验和 Codex shared 文件读取的宽松 canonicalization 分开。

### 开发 TODO

- [x] 修改 `packages/cli/src/generators/hooks.ts`，公共 hook 事件映射改走 `renderPublicHookEvent(...)`。
- [x] 新增 native hook 到原生 hook group 的转换函数，不再映射事件名。
- [x] 新增 `resolvePlatformHookDefinitions(plugin, platform)` 或同等 helper，合并公共 hooks 的目标平台生效视图与 `nativeHooks.<platform>`。
- [x] 公共 `session_start` 未写 matcher 时，Claude / Codex artifact 都显式渲染 `matcher: "startup|resume|clear"`。
- [x] matcherless native 事件渲染时不写 `matcher` 字段。
- [x] 合并公共和 native hooks 后稳定排序，保持构建产物可复现。
- [x] `renderCodexHooks(...)` 继续支持多插件聚合，聚合输入包含公共 hooks 和 Codex native hooks。
- [x] 修改 `packages/cli/src/utils/rendered-contract.ts`，Claude rendered validator 事件集合扩展为完整 Claude native allowlist。
- [x] 修改 Codex rendered validator，事件集合扩展为 6 个 Codex native 事件。
- [x] 将 rendered contract 拆成 strict generated mode 与 Codex shared read/write mode。
- [x] strict generated mode 中，matcherless 事件出现 `matcher` 直接报错。
- [x] strict generated mode 中，handler 首版只接受 `{ "type": "command", "command": string }`。
- [x] Codex shared read/write mode 接受所有事件上 `matcher` 缺省、`null` 或 string。
- [x] Codex matcher-capable 事件把缺省、`null`、`""`、`"*"` 规整成同一个 match-all identity。
- [x] Codex `UserPromptSubmit` / `Stop` 把缺省、`null` 或任意 string matcher 规整成无 matcher。
- [x] Codex shared read/write mode 拒绝 number / boolean / array / object matcher。
- [x] Codex shared read/write mode 接受并原样保留 command handler 的 `timeout`、`statusMessage`。
- [x] Codex shared read/write mode 将显式 `async` command、`prompt`、`agent` 分类为 opaque foreign raw group。
- [x] 实现 `normalizeCodexSharedHookGroupForRead(...)` 或同等 helper。
- [x] 实现 `parseCodexSharedHooksFile(...)` 或同等 helper，返回 raw groups、AW-managed identity multiset 和 opaque foreign raw groups。
- [x] 实现 `planCodexSharedHooksUpdate(...)` 或同等 helper，区分本次重渲染 AW groups、不可解析历史 AW raw groups、非 AW foreign raw groups。
- [x] 只有整组精确等于 CLI 生成的单 handler、最小同步 command shape 时，才进入 AW managed identity。
- [x] 多 handler group、mixed group、带额外 runtime 字段的 command group 都作为 opaque foreign raw group 原样保留。
- [x] `compareCodexHookGroups()`、`serializeCodexHookGroup()`、`normalizeCodexHookGroups()`、`codexHookGroupsContainAll()`、`subtractCodexHookGroups()` 迁移到 canonical identity helper。
- [x] `GeneratedArtifact.hookGroups` 改为保存 tracking identity。
- [x] `mergeGeneratedArtifacts()` 的 hook group 去重 key 改走 canonical identity。

### 自动化测试

- [x] 更新 `packages/cli/tests/unit/generators.test.ts`，覆盖 Claude artifact 同时包含公共事件和 Claude native 事件。
- [x] 覆盖 Codex artifact 同时包含公共事件和 Codex native 事件。
- [x] 公共事件映射测试只断言 `before_tool`、`after_tool`、`session_start`。
- [x] stop 类输出改用 native hook 用例覆盖。
- [x] 覆盖公共 `session_start` 默认 matcher 渲染为 `startup|resume|clear`，不会渲染成 `*` 或省略。
- [x] 覆盖 matcherless native 事件生成的 hook group 不带 `matcher`。
- [x] 覆盖 hooks 生成排序稳定。
- [x] 更新 `packages/cli/tests/unit/rendered-contract.test.ts`，Claude validator 接受完整 Claude native allowlist。
- [x] 覆盖 Claude / Codex validator 拒绝 allowlist 之外事件。
- [x] 覆盖 strict generated validator 拒绝 matcherless 事件中的 `matcher`。
- [x] 覆盖 strict generated validator 拒绝非最小同步 command handler，包括 `timeout`、`async`、`statusMessage`、`prompt`、`agent`。
- [x] 覆盖 Codex shared read mode 接受 matcher 缺省和 `matcher: null`。
- [x] 覆盖 Codex matcher-capable 事件的 match-all canonicalization。
- [x] 覆盖 Codex `UserPromptSubmit` / `Stop` 携带 inert matcher 时 canonical identity 丢弃 matcher。
- [x] 覆盖 Codex shared read mode 拒绝非法 matcher JSON 类型。
- [x] 覆盖外部 command handler 的 `timeout` / `statusMessage` 被保留且不进入 AW identity。
- [x] 覆盖 `async` command、`prompt`、`agent` 被分类为 opaque foreign group。
- [x] 覆盖同一 `event + matcher + command` 但 runtime 字段不同的外部 groups 不会合并成同一个 AW identity。
- [x] 覆盖多 handler group 和 mixed group 不会被拆分、认领、扣减或满足 drift。
- [x] 覆盖 `mergeGeneratedArtifacts()` 对 hook groups 使用 canonical identity 去重。
- [x] 运行 `pnpm test:unit`。

### 阶段验收

- [x] 公共 hooks 与 native hooks 能合并到同一份 Claude / Codex hooks artifact。
- [x] strict generated mode 能挡住 CLI 自己不该生成的 matcherless matcher 和非最小 command handler。
- [x] Codex shared read/write mode 能读取 runtime-valid 外部配置，并保留 AW 不管理的 raw groups。
- [x] Codex shared parser 以 raw matcher group 为所有权单位，不按 handler 粒度拆分。
- [x] tracking identity 与 rendered artifact 类型已经分离，matcherless 事件没有伪 matcher。

## 阶段 3：bundle source manifest、embedded catalog 与 Claude bundle

### 目标

堵住 `nativeHooks` 作为可选字段在 bundle 链路中静默丢失的问题，并让 Claude bundle 生成物开始消费公共 hooks + Claude native hooks。

### 开发 TODO

- [x] 修改 `packages/cli/src/utils/manifest.ts` 的 `createBundleSourceManifest(plugin)`，深拷贝 `extensions.nativeHooks.claude` / `extensions.nativeHooks.codex`。
- [x] 确保修改 bundle source manifest 的 `nativeHooks` 不会污染原始 plugin manifest。
- [x] 确保 `resolvePluginsFromCatalog()` 读取 embedded bundle 时，返回的 `PluginMeta.manifest.extensions.nativeHooks` 与 source manifest 一致。
- [x] 修改 `packages/cli/src/generators/local-plugin.ts`，Claude bundle 生成 `claude/hooks/hooks.json` 时合并公共 hooks 与 `nativeHooks.claude`。
- [x] 保持 `.claude-plugin/plugin.json.hooks` 只指向 `./claude/hooks/hooks.json`。
- [x] 确保 bundle layout validator 对 CLI 生成的 hooks artifact 走 strict rendered validator。
- [x] 检查 marketplace mirror 和 embedded root 生成链路，不再有只复制 `extensions.hooks` 的旧逻辑。

### 自动化测试

- [x] 更新 `packages/cli/tests/unit/manifest-coverage.test.ts`，断言 `createBundleSourceManifest()` 深拷贝 `extensions.nativeHooks`。
- [x] 覆盖修改 bundle source manifest 的 `nativeHooks` 不污染原始 plugin manifest。
- [x] 覆盖 `resolvePluginsFromCatalog()` 或 build-free catalog fixture 能从 synthetic embedded root 读回 `nativeHooks`。
- [x] 更新 `packages/cli/tests/unit/marketplace.test.ts`，断言 build 后 Claude bundle hooks 通过 rendered validator。
- [x] 在 bundle layout 校验之外，单独断言 bundle source manifest 保留 `nativeHooks`。
- [x] 更新 `packages/cli/tests/unit/generators.test.ts`，覆盖 Claude bundle hooks 文件同时包含公共映射事件和 Claude native 事件。
- [x] 运行 `pnpm test:unit`。

### 阶段验收

- [x] `nativeHooks` 能完整穿过 source -> bundle source manifest -> embedded catalog。
- [x] Claude bundle 里的 `claude/hooks/hooks.json` 同时包含公共映射事件和 Claude 原生事件。
- [x] `.claude-plugin/plugin.json` 的 hooks 入口仍然只指向 bundle 内真实文件。
- [x] 可选字段不会因为 bundle layout 校验“结构合法”而静默丢失。

## 阶段 4：Codex adapter、shared hooks 写回与 tracking

### 目标

把 Codex shared `.codex/hooks.json` 当成共享注册表处理。install / upgrade / uninstall 只能管理 AW 自己可重渲染或 tracking 到的整组 hook，不能重建整份文件、不能误删外部配置，也不能因为无关历史插件不可解析而失败。

### 开发 TODO

- [x] 修改 `packages/cli/src/adapters/codex.ts` 的 `hasRepoManagedArtifacts(...)`，把 `nativeHooks.codex` 计入 hooks artifact evidence。
- [x] install / upgrade 写 `.codex/hooks.json` 或 user hooks 时，聚合公共 hooks 和 `nativeHooks.codex`。
- [x] 将 `syncCodexHooks()` 改成基于 shared hooks 写回计划，而不是按 AW 当前插件重建整份文件。
- [x] 安装或升级当前插件前，读取现有 shared hooks 文件并使用 Codex shared read/write parser。
- [x] 当前目标插件始终进入本次重渲染集合。
- [x] 其它 tracked hook 插件尽力从 current catalog 或 active local bundle 解析；可解析者进入本次重渲染集合。
- [x] 当前不可解析但 tracking 中有 hook identity 的插件进入历史 AW raw groups 保留集合。
- [x] 如果历史 AW raw group 能从现有 shared 文件按 tracking identity 命中，写回时按原始 JSON shape 保留。
- [x] 如果历史 AW tracking identity 在 shared 文件中已缺失，不为无关插件自动合成 group，也不阻断当前插件操作。
- [x] 非 AW foreign raw groups 原样保留。
- [x] 写回时只从 raw groups 中扣除本次重渲染集合的旧 AW identities，再追加新渲染结果。
- [x] uninstall 根据 tracking 中的最终 hook identities 精确移除当前插件自己的 AW-managed raw groups。
- [x] 如果 expected command 只出现在 multi-handler 或 mixed foreign group 内，uninstall 不拆组删除，status / drift 负责报告缺失或 unmanaged overlap。
- [x] 拆掉 `resolveTrackedPlugins()` 作为 install / upgrade 硬前提的用法，改为“尽力解析其它 tracked 插件”的 helper。
- [x] 只有 tracking manifest 读取失败、shared hooks 文件非法、当前目标插件非法这类会导致写坏文件的问题才让命令失败。
- [x] tracking manifest 中的 hook groups 记录最终渲染后的事件名、canonical matcher 和 handler。
- [x] matcherless event 的 tracking identity 不记录伪 matcher。
- [x] historical rebuild fallback 使用同一套三类分流，不按 AW-only 视角重建整份 shared hooks 文件。
- [x] `readCodexHookGroups(...)` 不能直接复用 strict generated validator；改用 shared read/write mode。
- [x] `writeCodexHookGroups(...)` 合并 preserved historical AW raw groups、preserved foreign raw groups 和新渲染 AW groups，不能把需要无损保留的 raw groups 送进 strict renderer 后丢字段。
- [x] `collectGeneratedArtifacts(...)`、tracking 写入、错误回滚附带 artifacts 全部使用新的 hook identity payload。

### 自动化测试

- [x] 更新 `packages/cli/tests/unit/codex-adapter.test.ts` 或同等测试，覆盖 `hasRepoManagedArtifacts(...)` 识别 `nativeHooks.codex`。
- [x] 覆盖 install 前 `.codex/hooks.json` 已存在外部 group 时，安装 hook-only / nativeHooks-only 插件后外部 group 仍保留。
- [x] 覆盖 Codex public hooks、`nativeHooks.codex` 和外部 groups 混合共存时，卸载一个 AW 插件只移除自己的 groups。
- [x] 覆盖读取外部 runtime-valid shared hooks 时接受 `UserPromptSubmit` / `Stop` 携带 inert matcher。
- [x] 覆盖读取 matcher-capable 事件上的缺省、`null`、`""`、`"*"` match-all 形态，并在 status / uninstall / drift 中视为同一 group。
- [x] 覆盖 command handler 的 `timeout` / `statusMessage` 在 install / uninstall / rebuild 后不被洗掉。
- [x] 覆盖 `prompt` / `agent` / `async` command group 不参与 AW 扣减。
- [x] 覆盖同一 command 但 runtime 字段不同的外部 group 不会在 multiset compare 或重建时被错误合并、扣减或覆盖。
- [x] 覆盖 multi-handler group 不被拆组、重排或误删。
- [x] 覆盖 install / upgrade 插件 A 时，tracked 插件 B 已不可解析但 B 的 raw groups 仍在，命令不失败且 B 原样保留。
- [x] 覆盖 install / upgrade 插件 A 时，只扣除 A 和本次可重渲染插件的旧 AW identities。
- [x] 覆盖不可解析历史 AW 插件的 tracking 仍在但 shared hooks 文件中 raw group 已缺失时，不合成 B，也不删除其它 groups。
- [x] 覆盖 uninstall / status / drift 对 matcherless native group 使用 canonical identity。
- [x] 运行 `pnpm test:unit`。

### 阶段验收

- [x] Codex `nativeHooks`-only 插件安装后会写入 `.codex/hooks.json`，卸载时只移除自己的 native hook group。
- [x] Codex shared hooks 写路径会保留外部 runtime-valid groups，包括带 `timeout` / `statusMessage` 的 command、`async` command、`prompt`、`agent` 和 multi-handler group。
- [x] 安装或升级插件 A 时，无关 tracked 插件 B 不可解析不会导致命令失败，也不会误删 B 的历史 raw groups。
- [x] 写回算法只替换本次明确可重渲染的 AW groups，不重建整份 shared hooks 文件。
- [x] tracking manifest 中保存的是最终 canonical identities，不保存 matcherless 事件的伪 matcher。

## 阶段 5：状态、drift 与 historical fallback

### 目标

让状态面按正确的信息源说话：当前 catalog 可用时看目标平台生效视图；Codex current catalog 缺失时用 tracking identities 做 expected groups；Claude hook-only 能力通过 capability snapshot 恢复；Codex ledger-only 不合成 hook placeholder。

### 开发 TODO

- [x] 检查并更新 `packages/cli/src/commands/common.ts` 的 historical target 恢复逻辑。
- [x] 更新 `createHistoricalExtensionKinds(...)` 和 `createHistoricalPluginMeta(...)`。
- [x] 当前 catalog 可用时，Claude / Codex 都从公共 hooks + 对应 `nativeHooks` 的目标平台生效视图识别 hook 能力。
- [x] Codex tracking artifact 可用时，可从 `artifact.kind === "hook"` 恢复历史 hook kind。
- [x] Codex current catalog 缺失但 tracking artifact 有 hook identities 时，status / drift 用 tracking identities 作为 expected groups。
- [x] Codex 只有 historical placeholder、没有可比较 tracking identities 时，status / drift 返回明确诊断或 `unknown`，不能从 placeholder `extensions.hooks` 反推 expected groups。
- [x] Codex 不从 `CodexCapabilitySnapshot.hasRepoManagedArtifacts` 合成 hook placeholder。
- [x] Claude adapter 的 `getClaudeManagedExtensions(plugin)` 把公共 hooks 和 `nativeHooks.claude` 的 Claude 生效视图计入 `hooks`。
- [x] `applyClaudeInstallLedger()` 写入 capability snapshot 时包含 `hooks`。
- [x] `resolveClaudeCatalogCompatibility()` 比较 current / installed managed extensions 时包含 `hooks`。
- [x] `createHistoricalPluginMeta()` 从 Claude ledger snapshot 恢复 `managedExtensions: ["hooks"]` 时，能生成带平台 override 的 hooks placeholder。
- [x] `loadPluginTargetsForCommand(..., allowHistoricalFallback: true)` 在当前 catalog 缺失时保留 Claude 历史 hooks 能力。
- [x] 确认 Claude `installExtensions()` 首版不因为 hooks 额外产出 `GeneratedArtifact.kind = "hook"`。
- [x] Claude runtime evidence 只作为“已启用证据”，hook kind 仍来自 current catalog 或 ledger snapshot。
- [x] Codex historical placeholder 只恢复 hook-capable 命令目标，不参与 native hook group 明细比对。
- [x] status / drift 如果发现 expected identity 只存在于 mixed foreign group 内，报告 drift / missing 或 unmanaged overlap。

### 自动化测试

- [x] 更新 `packages/cli/tests/unit/claude-adapter.test.ts`，覆盖 Claude hook-only 插件会把 `hooks` 写入 ledger `capabilitySnapshot.managedExtensions`。
- [x] 覆盖 `resolveClaudeCatalogCompatibility()` 比较 current / installed managed extensions 时包含 `hooks`。
- [x] 覆盖当前 catalog 缺失或 capability changed 时，Claude 状态判断不会把历史 hooks 能力当成不存在。
- [x] 覆盖 Claude hook-only 插件的 `installExtensions()` 不额外产出 `kind: "hook"` tracking artifact。
- [x] 更新 `packages/cli/tests/unit/adapter-status.test.ts`，覆盖 `loadPluginTargetsForCommand(..., allowHistoricalFallback: true)` 从 Claude ledger 恢复 hook-only 历史插件。
- [x] 覆盖 historical placeholder 的 hook `agentOverrides` 仍按原平台收窄，不把 Claude-only hooks 泄漏给 Codex。
- [x] 覆盖 Claude 只有 ledger snapshot、没有当前 catalog 和 hook tracking artifact 时，也能恢复 hooks 能力。
- [x] 覆盖 Codex 只有 ledger snapshot 且只有 `hasRepoManagedArtifacts: true` 时，不合成 hook placeholder。
- [x] 覆盖 Codex 只有 tracking artifact 记录 `kind: "hook"` 时才恢复 hook 能力。
- [x] 覆盖 Codex historical hook placeholder 只恢复 hook kind，不承诺还原 native event 明细。
- [x] 覆盖 adapter status 不会用 Codex placeholder 的 `extensions.hooks` 覆盖 tracking identities。
- [x] 覆盖 current catalog 缺失时，tracked `nativeHooks.codex` 插件的 status expected groups 来自 tracking artifact。
- [x] 覆盖 current catalog 缺失时，公共 hooks + `nativeHooks.codex` 混合插件能按 tracking identities 确认 shared hooks 文件仍可见。
- [x] 运行 `pnpm test:unit`。

### 阶段验收

- [x] install、upgrade、uninstall、status 都能识别 native hooks 带来的 hooks 能力。
- [x] Claude hook-only 插件能进入 capability snapshot，且 current catalog 缺失时 historical fallback 能恢复 hooks 占位能力。
- [x] Claude 首版不要求 hook tracking artifact。
- [x] Codex current catalog 缺失后的 expected groups 只来自 tracking identities，不来自 historical placeholder。
- [x] Codex ledger-only 场景不会凭 `hasRepoManagedArtifacts` 误恢复 hook kind。

## 阶段 6：作者工具、参考文档与用户文档

### 目标

让插件作者入口和活动文档全部改成新口径，避免代码支持了 `nativeHooks`，但脚手架、校验脚本和示例仍停在旧公共 hooks 模型。

### 开发 TODO

- [x] 更新 `.agents/skills/create-agent-workflows-plugin/SKILL.md`。
- [x] 更新 `.agents/skills/create-agent-workflows-plugin/references/extensions-spec.md`。
- [x] 更新 `.agents/skills/create-agent-workflows-plugin/references/comprehensive-example.md`。
- [x] 更新 `.agents/skills/create-agent-workflows-plugin/scripts/validate_plugin.js`。
- [x] 更新 `docs/coding-conventions.md`，补充 `NativeHookDefinition`、`RenderedHookGroup`、`TrackedHookGroupIdentity` 等类型边界。
- [x] 更新 `docs/plugin-authoring.md`。
- [x] 更新 `docs/plugin-installation.md`。
- [x] 文档说明 `extensions.hooks` 是公共 hook，不等于 Claude / Codex 原生全集。
- [x] 文档说明公共 `session_start` 只表示 `startup / resume / clear`。
- [x] 文档说明 Claude compact 场景应写 `nativeHooks.claude[].event = "SessionStart"` 和 `matcher: "compact"`。
- [x] 文档说明 `extensions.nativeHooks.<agent>` 是平台独享 hook 入口，事件名写原生名。
- [x] 文档说明 matcherless 事件不要写 `matcher`。
- [x] 文档说明 `agentOverrides` 用于公共条目的平台排除或字段覆盖，不用于 native hooks。
- [x] 文档说明 `session_stop` 已从公共 hook 移除，Claude `Stop` / `SessionEnd`、Codex `Stop` 应写到对应 native hooks。
- [x] 清理示例中旧的公共 `session_stop`。
- [x] 给作者工具补 native hooks 示例。

### 自动化测试

- [x] 更新 `packages/cli/tests/integration/authoring-tools.test.ts`，覆盖作者工具接受 native hooks 示例。
- [x] 覆盖作者工具拒绝跨平台事件误写。
- [x] 覆盖作者工具拒绝 matcherless native 事件写 `matcher`。
- [x] 覆盖作者工具拒绝公共 `session_stop`。
- [x] 运行 `pnpm test:integration`。

### 阶段验收

- [x] 作者工具给出的 native hooks 示例可以通过校验。
- [x] 作者工具会拒绝跨平台事件误写和旧公共 `session_stop`。
- [x] 活动文档不再把公共 hooks 描述成平台原生事件全集。
- [x] 文档能清楚解释公共 hooks、native hooks、matcher 能力和 `agentOverrides` 的边界。

## 阶段 7：命令级集成回归与最终 smoke

### 目标

把 `nativeHooks` 的完整链路压到命令级：source manifest、bundle source manifest、embedded catalog、命令解析、adapter install / uninstall / status、historical rebuild 和外部 shared hooks 保留都要有回归。

### 开发 TODO

- [x] 补充 native hook-only、公共/native 混合、外部 shared hooks、historical catalog missing 的集成夹具。
- [x] 确保夹具覆盖 pure native hook 与公共/native 混合 hook，不只覆盖旧公共 hooks 路径。
- [x] 确保命令级用例能验证 source -> bundle source manifest -> embedded catalog -> command -> adapter 主链路。
- [x] 确保 smoke fixture 中存在带 `nativeHooks` 的样例插件。
- [x] 检查所有测试夹具里旧 `session_stop` 已移除或改到 native hooks。
- [x] 检查最终 `pnpm build` 产物里的 hooks artifact 都能通过 strict rendered validator。

### 自动化测试

- [x] 更新 `packages/cli/tests/integration/cli.test.ts`，覆盖 Codex `nativeHooks`-only 插件 project-scope install 会写 `.codex/hooks.json`。
- [x] 覆盖 Codex `nativeHooks`-only 插件 uninstall 会精确移除自己的 native hook group。
- [x] 覆盖 Codex project-scope install / upgrade 遇到已有外部 shared group 时，AW groups 写入后外部 group 仍保留。
- [x] 覆盖 current catalog 缺失后，剩余 tracked `nativeHooks.codex` hook 能被 historical rebuild 保留。
- [x] 覆盖 current catalog 缺失后，对历史 `nativeHooks.codex`-only 插件执行 status，按 tracking identities 报告 hooks 可见。
- [x] 覆盖 current catalog 缺失后，公共 hooks + `nativeHooks.codex` 混合插件的 status 能识别两类历史 groups。
- [x] 覆盖 current catalog 缺失后的 Codex historical rebuild 不会抹掉 shared 文件中的外部 group。
- [x] 覆盖多插件共享 `.codex/hooks.json` 时，公共 hooks 与 `nativeHooks.codex` 混合聚合和扣减正确。
- [x] 覆盖卸载其中一个插件后，其它插件的公共和 native hook group 都保留。
- [x] 覆盖存在外部 runtime-valid groups 时，卸载其中一个 AW 插件后其它 AW groups 和外部 groups 都保留。
- [x] 覆盖已有外部 multi-handler shared group 时，再安装或升级 AW hook 插件不会拆组、重排组内 handlers 或误删外部 handler。
- [x] 覆盖 AW expected command 只存在于 mixed group 内时，status 按 drift / unmanaged overlap 处理。
- [x] 覆盖 marketplace 或 `init --force` 刷新后，插件 B 从 current catalog 和 active local bundle 消失，但 tracking 与 shared raw groups 仍在；安装或升级插件 A 时 B 原样保留。
- [x] 至少补一条 Claude 命令级回归，覆盖 `nativeHooks.claude` hook-only 插件穿过 embedded catalog 和 ledger snapshot。
- [x] 更新 `packages/cli/tests/smoke/build-smoke.test.ts`，带 `nativeHooks` 的样例插件仍能通过 bundle layout 校验。
- [x] 运行 `pnpm test:unit`。
- [x] 运行 `pnpm test:integration`。
- [x] 运行 `pnpm build`。
- [x] 运行 `pnpm test:smoke:build`。

### 阶段验收

- [x] CLI 集成测试覆盖 `nativeHooks` 的 source -> bundle source manifest -> embedded catalog -> command -> adapter 主链路。
- [x] Codex native hook-only 安装 / 卸载、public/native/外部 hooks 混合共享文件保留都有命令级回归。
- [x] current catalog 缺失后的 Codex native hooks、外部 groups 保留和 status 口径都有命令级回归。
- [x] 至少一条 Claude native hook-only 的状态或 historical fallback 回归通过。
- [x] `pnpm test:unit`、`pnpm test:integration`、`pnpm build`、`pnpm test:smoke:build` 全部通过。

## 总体验收清单

- [x] 插件可以同时声明公共 hooks、Claude native hooks、Codex native hooks。
- [x] 公共 hooks 只接受 `before_tool`、`after_tool`、`session_start`。
- [x] `event: "session_stop"` 在 source manifest 校验阶段失败。
- [x] 公共 `session_start` 只覆盖 `startup / resume / clear`；`compact`、`*` 或正则 matcher 在 source manifest 校验阶段失败。
- [x] 公共 `session_start` 未写 matcher 时，最终 artifact 显式写成 `startup|resume|clear`。
- [x] Claude bundle 中的 `claude/hooks/hooks.json` 同时包含公共映射事件和 Claude 原生事件。
- [x] Codex `.codex/hooks.json` 或 user hooks 文件同时包含公共映射事件和 Codex 原生事件。
- [x] 非目标平台不会收到另一个平台的 native hooks。
- [x] 非法原生事件在 source manifest 校验阶段失败。
- [x] matcherless 原生事件写 `matcher` 会在 source manifest 校验阶段失败，strict generated rendered validator 也会拒绝。
- [x] Codex shared hooks 读路径接受 runtime-valid matcher 形态，并正确做 canonicalization。
- [x] Codex shared hooks 写路径保留现有非 AW hook groups。
- [x] Codex install / upgrade 遇到同一 shared 文件里的另一个 tracked hook 插件不可解析时不会失败。
- [x] Codex current catalog 缺失后的 status / drift 使用 tracking artifact 中的 canonical hook identities 作为 expected groups。
- [x] Codex shared read/write mode 原样保留外部 command handler 的 `timeout` / `statusMessage`。
- [x] Codex shared read/write mode 把 `async` command、`prompt`、`agent` 作为 opaque foreign groups 带过。
- [x] Codex shared read/write mode 以 raw matcher group 为所有权单位，多 handler group 和 mixed group 不拆分。
- [x] embedded bundle 的 `.agents-plugin/plugin.json` 保留 `extensions.nativeHooks`。
- [x] CLI 自己生成的 rendered hooks artifact 中出现非法事件或非最小同步 command handler 时，bundle / install preflight 会失败。
- [x] install、upgrade、uninstall、status 都能识别 native hooks 带来的 hooks 能力。
- [x] ledger-only historical fallback 首版只要求 Claude 从 `capabilitySnapshot.managedExtensions` 恢复 hook-only 能力。
- [x] Codex 不凭 `hasRepoManagedArtifacts` 合成 hook placeholder。
- [x] Claude native allowlist 与 2026-04-27 复核的上游 `HOOK_EVENTS` 完整一致。
- [x] Codex matcherless native hooks 在 artifact、tracking、drift、uninstall 和 generated artifact merge 中都不依赖伪 matcher。
- [x] Claude hook-only 插件能把 `hooks` 写进 capability snapshot，且不会额外要求 `kind: "hook"` tracking artifact。
- [x] CLI 集成测试覆盖 `nativeHooks` 的完整主链路。
- [x] 作者工具和参考文档给出的示例可以通过校验。

## 建议执行顺序

1. 先完成阶段 1，把 source contract、类型和 validator 固定下来。
2. 再做阶段 2，让 artifact 渲染、strict 校验、Codex shared parser 和 canonical identity 都稳定。
3. 阶段 3 单独处理 `nativeHooks` 在 bundle source manifest 与 embedded catalog 中的 round-trip。
4. 阶段 4 集中改 Codex adapter，不和 status / historical fallback 混在一起。
5. 阶段 5 再收口状态面、drift 和 historical fallback 的信息源。
6. 阶段 6 更新作者工具和文档，避免生态入口继续暴露旧 contract。
7. 最后做阶段 7，用命令级集成测试和 smoke 把整条链路压住。
