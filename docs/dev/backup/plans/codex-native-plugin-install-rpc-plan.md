# Codex 原生插件安装/卸载 RPC 接入执行计划

日期：2026-05-04  
来源：[`../specs/codex-native-plugin-install-rpc.md`](../specs/codex-native-plugin-install-rpc.md)  
状态：待执行

## 目标

把 Codex user scope 的原生插件安装和卸载从“只改 `~/.codex/config.toml`”改为复用 Codex app-server 的 `plugin/install` 与 `plugin/uninstall`，让 Codex 同时得到 enabled config 和 materialized cache。

本计划还要补齐 native write 成功后 AW 后续步骤失败时的恢复语义：插件级 native recovery breadcrumb 必须能独立于 `installed.json` 被读取，并且不会被本地 marketplace 刷新擦除。

## 执行边界

本轮覆盖：

- `aw install <plugin> -p codex -s user`
- `aw upgrade <plugin> -p codex -s user`
- `aw upgrade --all -p codex -s user`
- `aw uninstall <plugin> -p codex -s user`
- `aw status` / `aw status --json`
- discovery、交互式 uninstall 候选、marketplace cleanup
- 相关文档、作者技能、测试夹具

本轮不覆盖：

- 手写 Codex cache，或复刻 Codex 安装规则。
- 使用 `codex app-server proxy` 作为备用路径。
- 修改 Codex 源码或等待公开 `codex plugin install` CLI。
- 改变 Claude Code 安装路径。
- 给 native install 后续失败补强原子 rollback。

## 总体方案

### app-server 写入路径

新增私有 client：`packages/cli/src/utils/codex-app-server-client.ts`。

它负责：

- 启动 `codex app-server`。
- 使用默认 stdio JSONL transport。
- 按 spec 发送 `initialize -> initialized -> plugin/install|plugin/uninstall`。
- 请求报文不带 `"jsonrpc": "2.0"`。
- 按 `id` 匹配响应，忽略无关 notification。
- 捕获 stderr、处理超时、清理子进程。
- 把启动失败、协议错误、unknown method、插件禁用、install policy 拒绝等错误转成 AW 可读错误。

暴露的最小 API：

```ts
installCodexPluginViaAppServer({
  marketplacePath,
  pluginName,
  cwd,
  env,
  runner,
})

uninstallCodexPluginViaAppServer({
  pluginId,
  cwd,
  env,
  runner,
})
```

`runner` 不强行复用现有 `NativeCliRunner`。如果长生命周期 stdio 进程难以塞进现有抽象，就新增一个小型 `CodexAppServerProcessRunner`，测试里用 fake runner 注入 JSONL 响应。

### 本地 native 状态

新增 helper：`packages/cli/src/utils/codex-native-state.ts`。

它只读本地文件，不启动 app-server：

- 读取用户级 `~/.codex/config.toml [plugins."<plugin>@aw"]`。
- 区分 `configEntryPresent` 与 `pluginEnabled`。
- 扫描 `~/.codex/plugins/cache/aw/<plugin>/...` 是否存在 active cache。
- 返回 `pluginInstalled`、`activeCachePath`、`activeCacheVersion`。
- 列出所有 `@aw` 的 enabled config evidence 和 cache evidence。
- 判断 `[marketplaces.aw]` 是否允许清理。
- 提供 install / uninstall post-check。

`enabled = false` 的 config entry 单独存在时不作为 discovery evidence，也不阻塞 marketplace cleanup。只有 uninstall post-check 检查当前目标时，disabled entry 残留才算未清干净。

### native recovery breadcrumb

新增 helper：`packages/cli/src/utils/codex-native-recovery.ts`。

计划采用独立文件存储：

```text
<AW_HOME>/native-recovery/codex/user/<plugin>@aw.json
```

这样 breadcrumb 和 `installed.json` 主体分离，但仍属于 AW 本机 runtime state。因为它放在 `AW_HOME` 下，必须同步修改 `packages/cli/src/utils/local-marketplace.ts`：

- `initializeLocalMarketplace()` staging 时保留 `native-recovery/`。
- `calculateBundleFingerprint()` 忽略 `native-recovery/`。
- `validateLocalMarketplaceLayout()` 不能把它当成 bundle 源码或未知污染清掉。
- `replaceDirectoryAtomically()` 刷新 `~/.aw` 后，未恢复 breadcrumb 仍在。

建议的 breadcrumb schema：

```ts
interface CodexNativeRecoveryBreadcrumb {
  version: 1;
  platform: 'codex';
  scope: 'user';
  marketplaceName: 'aw';
  pluginName: string;
  pluginId: `${string}@aw`;
  state:
    | 'pending_after_native_write'
    | 'post_check_failed'
    | 'lifecycle_failed'
    | 'tracking_write_failed'
    | 'ledger_write_failed'
    | 'snapshot_write_failed'
    | 'cleanup_failed';
  reason: string;
  nativeWrittenAt: string;
  updatedAt: string;
  marketplacePath?: string;
  pluginVersion?: string;
  bundleFingerprint?: string;
  activeCachePath?: string;
  lastError?: string;
}
```

落盘要求：

- 只有 `plugin/install` 成功返回后才能创建。
- 创建或刷新必须早于 post-check、lifecycle、tracking、ledger、snapshot 写入和 GC。
- 初始状态用 `pending_after_native_write`。
- 后续步骤失败时刷新成具体失败原因。
- 安装全流程成功后删除；删除失败时命令不能报完全成功。
- `plugin/uninstall` post-check 通过后删除；删除失败时 status 继续提示可重试清理。

### 错误元数据

`CodexAdapter.installPlugin()` 内部会出现三类失败：

- app-server install 没成功，Codex native side effect 不可信。
- app-server install 成功，但 breadcrumb 写入失败。
- app-server install 成功且 breadcrumb 已持久化，但 post-check 或后续 AW 步骤失败。

为了让 `commands/install.ts` 的 rollback 语义准确，需要新增可解析的错误元数据，例如：

```ts
interface NativeWriteFailureMetadata {
  platform: 'codex';
  scope: 'user';
  pluginName: string;
  nativeWriteSucceeded: boolean;
  recoveryBreadcrumbPersisted: boolean;
  recoveryState?: CodexNativeRecoveryBreadcrumb['state'];
}
```

命令层通过 helper 提取 metadata：

- `nativeWriteSucceeded === false`：按普通失败处理，不写 config-only fallback。
- `nativeWriteSucceeded === true && recoveryBreadcrumbPersisted === false`：命令失败，错误说明 AW 缺少恢复证据；不能暗示后续 repair / uninstall 一定可自动授权。
- `nativeWriteSucceeded === true && recoveryBreadcrumbPersisted === true`：命令失败，但恢复真值归插件级 breadcrumb；只要 rollback 没留下跨插件不确定性，就不能把全局 `installed.json.ledgerState.status` 标成 degraded。

### 输出与 debug log 合同

这次改造不能只更新失败文案；默认输出、`--verbose` 输出和 debug log 都要能看出 native 写入走到了哪一步。

新增或扩展这些 command event：

- `native:marketplace`：覆盖 marketplace add / verify，`data` 至少包含 `platform`、`scope`、`plugin`、`marketplaceName`、`marketplacePath`、`phase: start|success|error`，失败时带 `errorCategory` 和可行动 `suggestion`。
- `native:rpc`：覆盖 app-server `plugin/install` / `plugin/uninstall`，`data` 至少包含 `platform`、`scope`、`plugin`、`pluginId`、`method`、`phase: start|success|error`、`durationMs`，失败时带 `errorCategory`、`nativeWriteSucceeded` 和 `suggestion`。
- `native:recovery`：覆盖 breadcrumb 写入、刷新和删除，`data` 至少包含 `platform`、`scope`、`plugin`、`pluginId`、`operation: write|update|delete`、`phase: start|success|error`、`state`、`nativeWriteSucceeded`、`recoveryBreadcrumbPersisted`。breadcrumb 写入失败时，event 必须明确表达 native side effect 已发生但恢复证据未持久化。
- `native:post-check`：覆盖 install / uninstall 后的 config 与 cache 校验，`data` 至少包含 `platform`、`scope`、`plugin`、`pluginId`、`operation: install|uninstall`、`pluginEnabled`、`configEntryPresent`、`pluginInstalled`、`activeCachePath`、`phase: start|success|error`。
- 扩展 `native:skipped`：Codex project repo-managed 路径必须使用稳定 reason，例如 `project_repo_managed_skipped_native`，并带 `platform`、`scope`、`plugin`、`requiresNativeRuntime`、`repoManagedArtifactKinds`，避免和 user native RPC 路径混在一起。

默认输出要求：

- 正常成功路径不输出 JSONL 或冗长协议细节，但要能区分 user native install/uninstall 走了 app-server RPC，project scope 是 repo-managed skipped native。
- breadcrumb 写入失败时，stderr 必须说明 Codex native 写入已发生、AW 没有持久化恢复证据，因此不能承诺自动 repair / uninstall 授权。
- breadcrumb 已落盘但后续步骤失败时，stderr 必须说明 native 已写入、AW 安装未完成，并提示用 `aw status --verbose` 查看 breadcrumb / cache / config 诊断。
- `--verbose` 继续通过 reporter event 展示上述 command event；debug log 必须持久化同一组 event payload，测试里要锁住 event 类型和关键字段，而不是只断言 stderr。

## 阶段计划

### 阶段 0：基线梳理

- [ ] 确认当前入口：
  - `packages/cli/src/adapters/codex.ts`
  - `packages/cli/src/commands/install.ts`
  - `packages/cli/src/commands/uninstall.ts`
  - `packages/cli/src/commands/upgrade.ts`
  - `packages/cli/src/commands/discovery.ts`
  - `packages/cli/src/commands/status.ts`
  - `packages/cli/src/types.ts`
  - `packages/cli/src/utils/local-marketplace.ts`
- [ ] 锁定当前行为的最小 regression tests：user native install 只写 enabled、status 把 enabled 当 installed、uninstall 只删 enabled。
- [ ] 给后续 fake Codex app-server 测试补一个通用 harness，避免每个测试手写进程模拟。

完成标准：测试能稳定复现当前假成功问题，且不依赖真实 Codex。

### 阶段 1：app-server client

- [ ] 新增 `codex-app-server-client.ts`。
- [ ] 实现 JSONL request / notification 写入。
- [ ] 实现 response 按 `id` 匹配、timeout、stderr capture、进程清理。
- [ ] 实现 `plugin/install` 和 `plugin/uninstall` 两个 API。
- [ ] 把 unknown method、invalid request、plugins disabled、install policy 拒绝、spawn failure 映射成清晰错误。
- [ ] 给 client 写 unit tests，覆盖成功、超时、stderr、unknown method、invalid request、plugins disabled、install policy 拒绝、spawn failure、非 JSON 行、提前退出。

完成标准：client 单测不碰真实 `codex`，但能完整校验协议顺序和错误文案。

### 阶段 2：native state 与 recovery 存储

- [ ] 新增 `codex-native-state.ts`。
- [ ] 实现 config enabled / config entry present 的读取。
- [ ] 实现 cache active version 扫描。
- [ ] cache active version 判定必须覆盖无效目录、多版本目录和非目录条目，规则要贴近 Codex loader 语义，不能只按父目录存在判断。
- [ ] 实现 install post-check：enabled 为 true 且 cache installed。
- [ ] 实现 uninstall post-check：目标 plugin config entry 不存在且 cache 不存在。
- [ ] 实现跨插件 native evidence 列表，用于 discovery 和 marketplace cleanup。
- [ ] 新增 `codex-native-recovery.ts`。
- [ ] 实现 breadcrumb 的原子读、写、更新、删除、按插件读取、全量扫描。
- [ ] 修改 `local-marketplace.ts`，保留并忽略 `native-recovery/`。
- [ ] 写 unit tests 验证 breadcrumb 在 `installed.json` 缺失或无效时仍可读。
- [ ] 写 unit tests 验证 `ensureLocalMarketplace()`、`aw init --force` 等刷新不会删除 breadcrumb。

完成标准：status / discovery 能依赖这些 helper 获得纯本地证据；breadcrumb 不再依赖 ledger 主体完整性。

### 阶段 3：CodexAdapter native install / uninstall 改造

- [ ] `CodexAdapter.installPlugin()` 保留 project scope 隔离与 native-only preflight。
- [ ] user scope 且不需要 native runtime 时继续 no-op。
- [ ] user scope 需要 native runtime 时按顺序执行：
  - `ensureLocalMarketplace()`
  - 解析 canonical `AW_HOME`
  - 检查 external ownership
  - 必要时执行 `codex plugin marketplace add <canonical AW_HOME>`
  - 验证 `[marketplaces.aw]` 指向 canonical `AW_HOME`
  - 计算 `<AW_HOME>/.agents/plugins/marketplace.json`
  - 调用 app-server `plugin/install`
  - 立即写入 `pending_after_native_write` breadcrumb
  - 执行 enabled/cache post-check
- [ ] 移除 install 主路径里的 `upsertCodexPluginEnabledFile()`；它只能保留给非 native 兼容路径或明确的验证修复。
- [ ] `CodexAdapter.uninstallPlugin()` 在最后一个 shared native ref 移除时调用 app-server `plugin/uninstall`。
- [ ] 为 breadcrumb-only 清理提供按 plugin id 卸载的能力，避免强依赖成功 scope record 或完整 `PluginMeta`。
- [ ] 卸载成功后执行 config entry/cache post-check。
- [ ] 移除 user native uninstall 主路径里的 `removeCodexPluginEnabledFile()` fallback。
- [ ] marketplace cleanup 改为检查 shared refs、breadcrumb、enabled config entry、active cache 四类 evidence。

完成标准：Codex user native install/uninstall 的副作用和 Codex 官方路径一致；RPC 不可用时命令失败，不退回 config-only。

### 阶段 4：install / uninstall / upgrade 命令语义

- [ ] 拆分 `createLifecycleConfigSnapshot()` 的职责：
  - `prepareLifecycleConfigSnapshot()` 只做只读计算，产出 digest、bundleFingerprint、scopeIdentity、snapshotRoot / bundleRoot / manifestPath 等 metadata，不创建 snapshot 目录、不复制 bundle。
  - `persistLifecycleConfigSnapshot(prepared)` 在后续明确时机执行真实落盘，用 staging copy + atomic move 创建 snapshot，并返回可写入 ledger / lifecycle scope record 的 metadata。
- [ ] `commands/install.ts` 可以在 native RPC 前调用只读 `prepareLifecycleConfigSnapshot()`，但不得在 app-server `plugin/install` 成功且 `pending_after_native_write` breadcrumb 成功持久化前调用 `persistLifecycleConfigSnapshot()`。
- [ ] `pending_after_native_write` breadcrumb 写入成功后，先持久化 lifecycle snapshot，再进入 install / upgrade lifecycle、tracking、ledger 和 snapshot GC；snapshot 持久化失败时把 breadcrumb 刷新成 `snapshot_write_failed`，命令失败且不写成功 ledger。
- [ ] install lifecycle 使用已持久化的 snapshot；ledger 只能记录已经落盘且通过基本校验的 snapshot metadata。rollback 只删除已持久化的 snapshot 或明确存在的 staging 目录，不能因为只读 metadata 存在就误报 snapshot 清理失败。
- [ ] `commands/install.ts` 在 native write 成功且 breadcrumb 已持久化后，后续失败只刷新插件级 recovery state。
- [ ] 收窄 `preserveLedgerState()` / rollback 里按 `nativeWritten` 写全局 degraded 的逻辑。
- [ ] full install 或 repair install 全部成功后删除对应 breadcrumb。
- [ ] breadcrumb 删除失败时，命令失败但保留可诊断状态；不要把成功安装 ledger 误回滚成未知状态。
- [ ] breadcrumb-only 显式 `install` 走 repair path：
  - 必须先按 current catalog 解析目标插件；如果当前 catalog 已经找不到该插件，命令必须失败。
  - catalog missing 的失败文案必须提示用户改用 `aw uninstall <plugin> -p codex -s user` 清理 native 残留。
  - 不能从 breadcrumb 或 historical evidence 猜测安装内容来继续 repair install。
  - 不从 breadcrumb 继承 install options。
  - 不把 breadcrumb 当成功账本。
  - 重新走 marketplace 注册、app-server install、post-check、lifecycle、tracking、ledger、snapshot。
  - 成功后删除 breadcrumb。
- [ ] breadcrumb-only 显式 `upgrade` 在 lifecycle、安装选项继承和 app-server install 前失败。
- [ ] `upgrade --all` 排除 breadcrumb-only 目标，记录 skipped，并提示先 install 修复或 uninstall 清理。
- [ ] `commands/uninstall.ts` 把 native recovery breadcrumb 作为卸载授权证据。
- [ ] breadcrumb-only uninstall 跳过插件自己的 uninstall lifecycle。
- [ ] breadcrumb-only uninstall 不调用 `getScopeRecordForUninstall()`，也不通过 current catalog 回退间接执行 lifecycle。
- [ ] breadcrumb-only uninstall 只执行 `plugin/uninstall`、post-check、breadcrumb 删除和 marketplace cleanup。
- [ ] 已有成功 scope record 的正常卸载继续保持现有 lifecycle 语义。

完成标准：repair install 能补齐 AW 账本并清除 breadcrumb；breadcrumb-only uninstall 能清掉 Codex native 残留，不运行插件 lifecycle。

### 阶段 5：discovery、status 与 JSON schema

- [ ] `DiscoveryEvidenceSource` 增加：
  - `codexNativeCache`
  - `codexNativeRecovery`
- [ ] Codex user discovery 合并三类本地 evidence：
  - enabled config entry
  - active cache
  - AW ledger / tracking / native recovery breadcrumb
- [ ] disabled-only config entry 不进入候选。
- [ ] cache-only 或 breadcrumb-only 插件进入 status 和交互式 uninstall 候选。
- [ ] 无 managed evidence / breadcrumb 的 cache-only 残留只能展示诊断，执行型命令不能静默删除。
- [ ] `NativePluginStatus` 语义更新：
  - `native.pluginInstalled` 表示 cache installed。
  - 新增 `native.pluginEnabled` 表示 config enabled。
  - 新增 config entry、active cache path 等诊断字段。
  - 新增 `native.recovery` 诊断对象，作为 `aw status --json` 的稳定字段：
    - `native.recovery.present`：是否存在 `codex / user / <plugin>@aw` native recovery breadcrumb。
    - `native.recovery.state`：breadcrumb 的恢复状态；不存在 breadcrumb 时为 `null`。
    - `native.recovery.reason`：breadcrumb 的恢复原因；不存在 breadcrumb 时为 `null`。
    - `native.recovery.evidenceMatches`：breadcrumb 是否和当前 enabled config entry 或 active cache 证据匹配；不存在 breadcrumb 时为 `null`。
    - `native.recovery.suggestion`：给调用方消费的恢复建议；存在 breadcrumb 时至少区分 repair install 与 uninstall cleanup，breadcrumb 与当前 native evidence 不匹配时必须给出诊断/人工确认建议。
  - `native.recovery` 只能表示恢复状态，不能被 health resolver、upgrade target 选择或 install options 继承逻辑当成成功 installed。
- [ ] status health resolver 按 spec 状态表重算 ready / needsAttention / notInstalled。
- [ ] `ready` 必须同时满足 cache installed、config enabled、成功 scope record、无 breadcrumb、无全局 degraded、无其它 drift。
- [ ] `--verbose` 和 `--json` 输出 enabled、installed、cache path、config path、marketplace health、breadcrumb 和 ledger degraded reason。
- [ ] 更新 `commands/common.ts` 中 status 文本输出，不再把 `pluginInstalled` 展示成旧 enabled 语义。
- [ ] status 默认输出遇到 native recovery breadcrumb 时要明确提示“Codex native 已写入、AW 未完成”，并区分 `pending_after_native_write`、具体失败状态和 breadcrumb 删除失败。

完成标准：`aw status --json` 完成 breaking change；status 默认路径仍是纯本地只读，不启动 app-server。

### 阶段 6：测试补齐

优先写单元测试，再补集成测试。每个阶段改动落地后都应尽早跑相关子集，避免最后一次性排错。

单元测试重点：

- app-server client 协议顺序与错误映射。
- app-server client 把 `invalid request`、`spawn failure`、`plugins disabled`、`install policy` 拒绝映射成清晰、可行动错误。
- install 调 app-server 而不是只写 enabled。
- install post-check 缺 cache 时失败。
- unknown method 不写 config-only fallback。
- marketplace add 失败时不启动 install RPC。
- 已注册 canonical marketplace 时仍调用 install RPC。
- `native.pluginInstalled` 改为 cache installed。
- 新增 `native.pluginEnabled`。
- enabled-only、cache-only、shared-ref-only、breadcrumb-only 的 health 判定。
- `installed=true`、`enabled=true`、且有成功 scope record 时判为 `ready`；同样 cache/config 都存在但只有 shared native ref、没有成功 scope record 时判为 `needsAttention`，且不能进入 `upgrade --all` ready target，也不能作为 install options / lifecycle snapshot 继承来源。
- `installed=false`、`enabled=false`，但仍有成功 managed evidence、shared native ref 或 native recovery breadcrumb 时判为 `needsAttention`，不能被 discovery/status 隐藏成 `notInstalled`。
- disabled-only config entry 且没有 cache / breadcrumb / managed evidence 时，不进入 discovery/status 候选，也不阻塞 marketplace cleanup。
- `aw status --json` 锁住 `native.recovery.present/state/reason/evidenceMatches/suggestion` 稳定字段；不存在 breadcrumb 时字段按 schema 返回 `false` / `null`，存在 breadcrumb 时建议能区分 repair install、uninstall cleanup 和 evidence mismatch 诊断。
- status 默认路径不启动 app-server。
- discovery 能扫描 cache active version 和 breadcrumb；cache 扫描要覆盖无效目录、多版本目录和非目录条目。
- breadcrumb 独立于 `installed.json`。
- breadcrumb 跨 `ensureLocalMarketplace()` / `aw init --force` 保留。
- native write 成功后先写 pending breadcrumb，再进入 post-check / lifecycle / tracking / ledger。
- snapshot 真实持久化发生在 pending breadcrumb 成功之后；snapshot 持久化失败会刷新 `snapshot_write_failed` breadcrumb，不写成功 ledger。
- breadcrumb 写入失败时立即失败，且不承诺自动 repair / uninstall 授权。
- 只有 `pending_after_native_write`、还没有具体失败原因的 breadcrumb，也能被 status / repair install / breadcrumb-only uninstall 当成有效恢复证据。
- breadcrumb-only uninstall 不运行 uninstall lifecycle。
- breadcrumb-only install 成功后写 ledger / tracking / snapshot，并删除 breadcrumb。
- breadcrumb-only install 在 current catalog 已找不到插件时失败，并提示 `aw uninstall <plugin> -p codex -s user` 清理残留。
- breadcrumb-only upgrade 显式失败，`upgrade --all` skipped。
- user native uninstall 调 app-server `plugin/uninstall`，不走 config-only fallback。
- 仍有 shared native refs 时，user native uninstall 不调用 app-server `plugin/uninstall`，不删除目标 native cache / enabled config，也不提前进入 `[marketplaces.aw]` cleanup。
- user native uninstall post-check 同时要求目标 config entry 不存在且 active cache 不存在。
- user native uninstall post-check 把 `enabled = false` 的目标 config entry 残留判为失败。
- `plugin/uninstall` 返回成功但 cache 或 config entry 仍存在时，卸载命令失败，不写干净 ledger / tracking。
- breadcrumb 删除失败时 install / uninstall 不能报告完全成功，status 继续暴露待清理恢复标记。
- marketplace cleanup 必须等待所有 shared refs、breadcrumb、enabled config、active cache 消失。
- Codex project scope 不调用 marketplace add / app-server / 用户级 config/cache。
- Codex project scope 没有 project-managed artifacts 的纯 native-only 插件拒绝安装。
- Codex project scope `apps` 插件拒绝安装。
- command event / debug log 覆盖 marketplace registration、install RPC、uninstall RPC、cache/materialization verification、project repo-managed skipped native，并锁住关键 payload。

集成测试重点：

- `aw install git-commit -p codex -s user` 后同时看到 enabled config 和 cache。
- app-server 启动失败、方法不可用、install 返回失败时命令非 0，stderr 可行动。
- debug log / `--verbose` 能区分 marketplace registration、install RPC、uninstall RPC、cache/materialization verification、project repo-managed skipped native；测试至少断言 event type、plugin、scope、method / reason 和关键状态字段。
- native write 成功、breadcrumb 已写、后续失败时 ledger 不写成功；status 显示 partial / needsAttention。
- native write 成功但 breadcrumb 写入失败时，不进入后续步骤，也不承诺自动 cleanup。
- native write 成功、pending breadcrumb 已写、但 snapshot 持久化失败时，breadcrumb 刷新为 `snapshot_write_failed`，status / repair install / breadcrumb-only uninstall 都能消费该恢复证据。
- `installed.json` 缺失或无效时，breadcrumb 仍支撑 status / discovery / uninstall / marketplace cleanup。
- breadcrumb-only repair install 前触发 marketplace refresh，breadcrumb 仍保留并最终被成功删除。
- breadcrumb-only upgrade 显式失败；`upgrade --all` skipped。
- breadcrumb-only uninstall 清 config/cache/breadcrumb，不运行 lifecycle，status 回到 `notInstalled`。
- 多插件 breadcrumb 或无归属 enabled/cache 残留存在时，不提前删除 `[marketplaces.aw]`。
- 命令开始前已有无关全局 degraded 时，repair / breadcrumb-only uninstall 不顺手清掉它。
- cache-only 状态能被 status 发现，交互式 uninstall 只展示诊断，不静默清理。
- install 后 uninstall，status 回到 `notInstalled`。
- project scope 在 PATH 缺少 `codex` 时仍能完成 repo-managed 写入。
- project scope 纯 native-only 插件和 `apps` 插件在写任何 repo artifact 前 fail fast。

必跑命令：

```bash
pnpm test:unit
pnpm test:integration
pnpm test:smoke:build
```

如果只改了窄模块，可以先跑对应 Vitest 文件；合并前必须跑完整三项。

### 阶段 7：文档与作者工具同步

- [ ] 更新 `docs/architecture.md`：Codex user native install/uninstall 改为 app-server RPC。
- [ ] 更新 `docs/plugin-installation.md`：说明 `--scope user`、故障排查、`aw status --json` breaking change。
- [ ] 更新 `docs/plugin-authoring.md`：说明 Codex user/project scope 对插件作者的影响。
- [ ] 更新 `docs/testing.md`：补 Codex native marketplace / app-server RPC 测试约定。
- [ ] 检查 `.agents/skills/create-agent-workflows-plugin/`：
  - `SKILL.md`
  - `references/plugin-manifest-spec.md`
  - `references/extensions-spec.md`
  - `references/comprehensive-example.md`
  - `scripts/validate_plugin.js`
  - 相关示例和夹具

完成标准：公开文档、作者技能和运行时行为没有互相打架的说法。

## 推荐落地顺序

1. 先做 app-server client 和 native state helper。它们独立、容易测试，也是后续所有改造的基础。
2. 再做 breadcrumb helper 与 `local-marketplace.ts` 保留逻辑。没有这一层，不要改 install 主路径。
3. 改 `CodexAdapter.installPlugin()`，让 user native install 真正 materialize cache。
4. 改 `status` 和 `discovery`，先让只读诊断能表达 enabled/cache/recovery 的真实状态。
5. 改 install rollback 和 repair install，收窄全局 degraded 语义。
6. 改 uninstall，补 breadcrumb-only cleanup 和 marketplace cleanup。
7. 最后改 upgrade、交互候选、文档和作者工具。

这个顺序的好处是每一步都有可见验收点：先能写，再能看，再能恢复，最后清理和升级语义收口。

## 关键风险

- Codex app-server 插件 RPC 仍是 under development，协议变动要被封装在 `codex-app-server-client.ts` 内。
- active cache version 的判定要贴近 Codex loader 语义；如果只按目录存在判断，测试必须覆盖无效目录、多版本目录和非目录条目。
- breadcrumb 删除失败发生在成功 ledger 写入之后，不能被普通 rollback 当成“安装从未成功”处理。
- cache-only evidence 没有 AW 归属证明，不能因为它进入 discovery 就允许执行型命令静默删除。
- `AW_HOME` 原子替换很容易误删 runtime state，`native-recovery/` 的 preserve 测试必须先写。
- `upgrade --all` 的 ready target 过滤要防止 breadcrumb-only 通过 fallback evidence 混进去。

## 最终验收

- 用户只运行 `aw install <plugin> -p codex -s user`，Codex 就能同时看到 enabled config 和 installed cache。
- AW 不再出现“命令成功，但 Codex runtime 报 plugin is not installed”的假成功。
- app-server 不可用或方法不可用时，命令失败且没有 config-only fallback。
- native write 成功后 AW 后续失败时，breadcrumb 已持久化的场景能被 status 识别为 `needsAttention`，且不把全局 ledger 错标成 degraded。
- breadcrumb 独立于 `installed.json`，也不会被 marketplace refresh 删除。
- breadcrumb-only install 可以修复；breadcrumb-only uninstall 可以清理；breadcrumb-only upgrade 会拒绝或 skipped。
- user native uninstall 清掉 cache 和 plugin config entry；install 后 uninstall，status 回到 `notInstalled`。
- `[marketplaces.aw]` 只在所有 `@aw` native evidence 都消失后才删除。
- `aw status --json` 的 `native.pluginInstalled` 表示 cache installed，`native.pluginEnabled` 表示 config enabled。
- Codex project scope 仍保持 repo-managed 隔离，不产生用户级 native 副作用。
- 默认输出、`--verbose` 和 debug log 都能区分 marketplace registration、install RPC、uninstall RPC、cache/materialization verification、project repo-managed skipped native；native side effect 已发生但恢复证据缺失或 AW 后续未完成时，stderr 和 debug event 都必须说清楚。
