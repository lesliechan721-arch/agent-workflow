# Codex 原生插件安装/卸载接入 app-server RPC 需求 Spec

日期：2026-05-02

## 背景

AW 当前的 Codex user scope 原生插件安装只完成了两件事：

- 通过 `codex plugin marketplace add <AW_HOME>` 注册本地 marketplace。
- 往 `~/.codex/config.toml` 写入 `[plugins."<plugin>@aw"].enabled = true`。

这条路径没有触发 Codex 自己的插件安装流程，所以不会把插件 materialize 到 `~/.codex/plugins/cache/...`。在 Codex 运行时模型里，“enabled”和“installed”是两层状态：config 里启用只说明用户希望启用插件；cache 里存在有效安装副本，Codex 才会把插件视为已安装并加载。

真实表现是：插件在列表里可能看得见、也显示 enabled，但运行时因为没有 cache 里的安装实体，仍会报未安装或不可用。用户手动在 Codex 内安装一次后，cache 被补齐，同一份 enabled 配置才开始生效。

## 调研核对结论

调研结论基本正确，关键点如下：

- Codex loader 加载 enabled plugin 时会先查 `PluginStore.active_plugin_root()`；找不到 active root 时直接把插件标记为 `plugin is not installed`。
- Codex 插件列表里的 `installed` 状态来自 `PluginStore.is_installed()`，本质也是查 `~/.codex/plugins/cache/<marketplace>/<plugin>/<version>` 是否存在有效版本。
- Codex 官方安装路径会先 materialize marketplace source，再写 cache，之后才写用户级 `[plugins."<plugin>@<marketplace>"].enabled = true`。
- AW 当前 `CodexAdapter.installPlugin()` 只注册 marketplace 并写 config enabled，确实没有进入 Codex 的 install path。
- 当前 Codex CLI 公开的 `codex plugin` 子命令只有 marketplace 管理，没有公开的 `codex plugin install`。

需要修正的一点：

- 当前本机 Codex checkout 中，插件 manager 实现位于 `core-plugins/src/manager.rs`，不是调研笔记里写的旧路径 `core/src/plugins/manager.rs`。逻辑结论不受影响。
- `codex app-server proxy` 不是简单的 JSONL stdio 代理。它把 stdio 字节转发到 control socket，而 control socket 侧期望 WebSocket upgrade 后的帧。除非 AW 实现 WebSocket-over-UDS 客户端，否则不应把它作为最小可用备用路径。

## 已确认决策

- Codex user scope 原生插件安装必须复用 Codex 内部安装接口，不再只写 `config.toml`。
- Codex user scope 原生插件卸载在当前插件没有剩余 shared native refs，且存在成功 AW managed evidence 或 native recovery breadcrumb 授权时，必须复用 Codex 内部 `plugin/uninstall` 接口清理 cache 和用户级 config，不能继续只删 enabled。
- 第一版采用私有 `codex app-server` 子进程，走默认 stdio JSONL transport。
- 写入型请求顺序为 `initialize -> initialized -> plugin/install` 或 `initialize -> initialized -> plugin/uninstall`。
- JSON-RPC 报文不带 `"jsonrpc": "2.0"` 字段，按 Codex app-server 当前协议实现。
- `plugin/install` / `plugin/uninstall` 失败、方法不存在、Codex 版本过旧或 app-server 不可用时，AW 直接失败，不降级成 config-only 假成功。
- `[marketplaces.aw]` 只有在没有任何 `@aw` 插件级 native evidence 时才允许删除。这里的 evidence 包括 AW native plugin shared refs、插件级 native recovery breadcrumb、用户级 `[plugins."<plugin>@aw"].enabled = true` config entry，以及 `~/.codex/plugins/cache/aw/<plugin>/...` active cache；`[marketplaces.aw]` 自身不计入 evidence。这里的 config-only 特指 config 已启用但 cache 缺失；`enabled = false` 的 disabled config entry 单独存在时不算 native evidence，不阻塞 discovery/status 候选或 marketplace cleanup。
- 继续保留 `codex plugin marketplace add <canonical AW_HOME>` 作为本地 marketplace 注册步骤，用来保持 Codex marketplace 列表、AW status 和后续发现路径一致。
- Codex project scope 不走 native plugin install。它仍然只写当前仓库 repo-managed artifacts。
- 当前能力尚未上线，不需要设计旧版 `sharedNativeRefs.projects` 迁移或历史污染清理。
- 本轮不承诺 native install 与 AW 后续步骤的跨系统原子性。只要 `plugin/install` 已经成功返回，后续 post-check、lifecycle、tracking 或 ledger 失败时，AW 命令必须失败、不能写成功账本，也不能把失败伪装成成功；但可以保留 Codex 已经写入的 native cache / enabled 副作用，由 `aw status` 暴露 partial / needsAttention 状态和恢复建议。主动调用 `plugin/uninstall` 回滚 install 后续失败不在本轮范围；正常 `aw uninstall` 清理 native 状态属于本轮范围。为了让用户能从这个残留状态恢复，AW 必须写入最小插件级 native recovery breadcrumb；该记录不是成功安装账本，但只要成功持久化，就必须足以授权后续 `aw uninstall <plugin> -p codex -s user` 进入 `plugin/uninstall`。如果连 breadcrumb 都无法持久化，本轮不承诺后续命令能自动获得 repair / uninstall 授权，只承诺错误、debug log 和只读 status 暴露 Codex native side effect 与人工处置建议。
- Codex native write 成功且恢复证据可持久化的 AW 后续失败，必须使用插件级 native recovery breadcrumb / recovery state 表达恢复真值。只要该插件级恢复证据已经成功持久化，AW 不得再仅因这个插件的 native side effect 把整份 `installed.json` 标成全局 `ledgerState.status = degraded`，也不得让后续成功 repair install / breadcrumb-only uninstall 继续背着这类全局 degraded。全局 degraded 只保留给整份 ledger 完整性未知、恢复证据无法持久化、rollback 造成跨插件不确定性等无法安全归到单个插件的场景。
- 插件级 native recovery breadcrumb 必须有独立于 `installed.json` 主体完整性的读取路径。即使 `installed.json` 缺失、结构无效并被重建为 degraded ledger，discovery、status、uninstall 和 marketplace cleanup 仍必须能读到尚未恢复的 `codex / user / <plugin>@aw` breadcrumb。
- 插件级 native recovery breadcrumb 的持久化还必须独立于本地 marketplace bundle 刷新。如果 breadcrumb 放在 `~/.aw` 内，它必须被定义为和 `plugin-config/`、`plugin-install-snapshots/` 同类的本地 runtime state，并在 `ensureLocalMarketplace()`、`aw init --force`、bundle fingerprint 变化触发的 refresh，以及 `replaceDirectoryAtomically()` 整体替换 `~/.aw` 时被保留。如果实现把 breadcrumb 放在 `~/.aw` 外，则该位置必须明确不受这些刷新/替换流程覆盖。任何 repair install、status、uninstall 或 marketplace cleanup 都不能因为刷新本地 marketplace 而先丢失尚未恢复的 breadcrumb。
- breadcrumb-only 目标，也就是只有插件级 native recovery breadcrumb、没有成功 scope record / shared native refs 的 `codex / user / <plugin>@aw`，允许用户用显式 `aw install <plugin> -p codex -s user` 修复；显式 `aw upgrade <plugin> -p codex -s user` 必须拒绝，并提示先运行 `install` 修复或运行 `uninstall` 清理。
- breadcrumb-only 卸载不运行插件自己的 `uninstall` lifecycle。breadcrumb 只授权 AW 调用 Codex `plugin/uninstall` 清理 native cache / config entry，并在 post-check 通过后删除 breadcrumb；它不能被当成 lifecycle snapshot 或“安装已完整成功”的证据。
- `aw status --json` 接受一次破坏性语义变更：`native.pluginInstalled` 从“用户级 config enabled”改为“Codex cache 中存在 active installed plugin”。JSON 输出需要新增能表达 config enabled 的字段，但不为旧版 `pluginInstalled === enabled` 语义提供过渡兼容。

## 目标

1. `aw install <plugin> -p codex -s user` 完成后，Codex 同时满足 installed 和 enabled 两层状态。
2. 安装成功不能依赖用户手动在 Codex 内再点一次安装。
3. AW 不再出现“命令成功，但 Codex 运行时判定 plugin is not installed”的假成功。
4. 失败时给出明确原因和下一步，例如升级 Codex、启用 Codex plugins feature，或检查本地 marketplace。
5. Codex project scope 保持 repo-managed 隔离，不因为插件包含 skills/MCP/slashCommands 而默认写入用户级 native plugin。
6. `aw status` 能区分用户级 config enabled 和 Codex cache installed，不能再把 `[plugins."<plugin>@aw"].enabled = true` 误报为已安装。
7. `aw uninstall <plugin> -p codex -s user` 完成后，不能留下会让 `aw status` 继续判成 installed / partial 的 Codex cache 残留。
8. 如果 install 在 Codex native write 成功且插件级 native recovery breadcrumb 已成功持久化后失败，用户仍然能用显式 `aw install <plugin> -p codex -s user` 修复，或用正常 `aw uninstall <plugin> -p codex -s user` 清理 cache / config entry，不会被 historical uninstall 保护提前拒绝。
9. repair install 或 breadcrumb-only uninstall 成功清掉插件级 native recovery breadcrumb 后，若没有其它独立的全局 ledger 损坏或外部证据，`aw status` 必须分别回到 `ready` 或 `notInstalled`，不能因为已愈合的 native write 失败继续停在 `needsAttention`。

## 非目标

- 不复刻 Codex 的 cache 写入规则，不由 AW 手动复制到 `~/.codex/plugins/cache`。
- 不把 `codex app-server proxy` 作为第一版备用路径。
- 不修改 Codex 源码，不新增公开 Codex CLI 子命令。
- 不在本轮处理历史未上线版本留下的 project native 迁移。
- 不改变 Claude Code 安装路径。

## 目标行为

### Codex User Scope 安装

当目标插件在 Codex user scope 下需要 native plugin runtime 时，AW 必须执行：

1. `ensureLocalMarketplace()`，确保 `~/.aw` 中有当前 AW 版本的 bundle。
2. 解析 canonical `AW_HOME`。
3. 确保 Codex user config 的 `[marketplaces.aw]` 指向 canonical `AW_HOME`，必要时调用：

```bash
codex plugin marketplace add <canonical AW_HOME>
```

4. 计算绝对 marketplace manifest path：

```text
<canonical AW_HOME>/.agents/plugins/marketplace.json
```

5. 启动私有 app-server：

```bash
codex app-server
```

6. 通过 stdio 写入 JSONL 请求：

```json
{"id":"init-1","method":"initialize","params":{"clientInfo":{"name":"aw","version":"<aw-version>"},"capabilities":{}}}
{"method":"initialized"}
{"id":"install-1","method":"plugin/install","params":{"marketplacePath":"<absolute-marketplace-json>","pluginName":"<plugin-name>"}}
```

`experimentalApi: true` 不是 `plugin/install` 成功的前置条件。实现可以为了兼容某个 Codex app-server 版本在 initialize capabilities 中带上它，但 spec 不把 AW 绑定到 experimental capability。

7. 等待 `install-1` 响应成功后，才认为 native install 成功。
8. 立刻写入或刷新插件级 native recovery breadcrumb，然后才允许进入 post-check、lifecycle、tracking、ledger、install snapshot 写入或 snapshot GC 等任何可能失败的 AW 后续步骤。
9. 做轻量 post-check：用户级 `[plugins."<plugin>@aw"].enabled = true` 已存在，并且 `~/.codex/plugins/cache/aw/<plugin>/...` 下能看到 active cache 版本。

`plugin/install` 本身会写 enabled，因此 AW 不应再把 `upsertCodexPluginEnabledFile()` 当成安装主路径。最多只能在验证或兼容修复中使用，而且不能绕过 cache 检查。

如果第 7 步已经成功，但第 8 步的 breadcrumb 写入失败，命令必须立即失败，不能继续进入第 9 步或其它后续阶段。错误文案和 debug event 要说明 Codex native side effect 已经发生，但 AW 未能持久化恢复证据，因此不能承诺后续 `aw install` repair 或 `aw uninstall` 一定能自动授权处理；用户需要用 `aw status --verbose`、debug log 或手动检查 Codex 状态来决定下一步，必要时按 Codex 原生方式清理 cache / enabled。

如果第 8 步已经成功，但第 9 步 / AW 后续 lifecycle / tracking / ledger 写入失败，命令结果仍是失败。失败处理只负责回滚 AW 自己能安全恢复的 repo artifacts、tracking、ledger 和 snapshot；不主动删除 Codex native cache 或 config enabled。此时状态属于“native side effect 已存在但 AW 安装未完成”，必须在错误文案、debug event 和后续 `aw status` 中清楚暴露，不能把账本写成成功安装，并且必须保留或更新插件级 native recovery breadcrumb。只要 rollback 能把全局 ledger / tracking 恢复到可置信状态，就不能仅因 `nativeWritten === true` 把全局 `ledgerState` 改成 degraded；本插件的待恢复状态由 breadcrumb 承担。

breadcrumb 的合同如下：

- 只在 `plugin/install` 已经成功返回后写入；如果 native write 没成功，不能创建。
- `plugin/install` 成功返回后，AW 必须先写入或刷新该 breadcrumb，才能继续执行 post-check、lifecycle、tracking、ledger、install snapshot 写入、snapshot 清理或其它可能失败的步骤。不能只在统一失败回滚分支里补写 breadcrumb，否则 native write 成功到回滚分支执行之间仍会存在无恢复证据窗口。
- 记录必须锚定到 `codex / user / <plugin>@aw`，并至少包含 plugin name、marketplace name、plugin id、scope、写入时间、恢复状态和原因；如果当时已经解析出版本或 bundle digest，也应一并保留，方便 status 诊断。
- breadcrumb 初次落盘时允许处于中间态，例如 `state: pending_after_native_write`、`reason: native_write_succeeded_post_steps_pending`，表示 Codex native write 已发生，但 post-check / lifecycle / tracking / ledger 尚未完成。只有后续步骤真的失败时，才把它刷新为具体失败状态和原因，例如 `post_check_failed`、`lifecycle_failed`、`ledger_write_failed` 或 `snapshot_write_failed`。如果进程在 breadcrumb 落盘后、具体失败原因形成前退出，status / uninstall / repair 必须仍能把这个 pending breadcrumb 当成有效恢复证据。
- breadcrumb 不能让 `scopeInitialized` 变成 `yes`，不能让 `aw status` 把插件判为 `ready`，不能参与 install options 继承、`upgrade --all` ready target、lifecycle snapshot 真值或成功安装 receipt。
- breadcrumb 必须被 discovery、status、交互式 uninstall 和显式 uninstall 识别为 AW 管理的恢复证据。只要本地 native evidence 仍能匹配 `codex / user / <plugin>@aw`，`aw uninstall <plugin> -p codex -s user` 必须继续进入 `plugin/uninstall`，不能因为缺少成功 scope record 被 historical uninstall 保护提前拒绝。
- AW 安装流水线全部成功、成功账本和 install snapshot 都已写入后，必须删除对应 breadcrumb；如果删除失败，命令仍不能报告为完全成功，status 必须继续提示存在待清理恢复标记。
- `plugin/uninstall` post-check 通过并清理 cache / config entry 后，AW 必须删除对应 breadcrumb；如果卸载失败，breadcrumb 保留，status 继续提示可重试清理。
- breadcrumb 是这类 native write 后失败的插件级恢复状态来源。它必须能按 `codex / user / <plugin>@aw` 精确读取、更新和删除，不能只靠全局 `ledgerState.reason = operation_interrupted_after_native_write`。
- breadcrumb 的持久化合同不能依赖 `installed.json` 主体可解析。推荐实现是独立文件；如果实现扩展 `installed.json` schema 增加插件级 recovery 区域，也必须同时维护一个独立可读的 breadcrumb 索引或等价读取路径，供 discovery、status、显式/交互式 uninstall 和 `[marketplaces.aw]` cleanup 使用。`installed.json` 缺失、结构无效或被 `readInstalledLedger()` 重建为空 degraded ledger 时，尚未恢复的 breadcrumb 不能因此丢失。
- breadcrumb 的持久化合同也不能被本地 marketplace 刷新破坏。`ensureLocalMarketplace()`、`aw init --force`、bundle refresh 和 `replaceDirectoryAtomically()` 不能删除尚未恢复的 breadcrumb；如果 breadcrumb 存在于 `~/.aw` 下，刷新流程必须在 staging 目录中 preserve / restore 它，并且校验布局时不能把它当成 bundle 源码或未知污染清掉。status、discovery、repair install、uninstall 和 marketplace cleanup 的读取路径必须在刷新前后保持一致。

#### ledger 恢复语义

Codex user native 的 recovery 语义按插件收敛：

- `plugin/install` 已成功且 breadcrumb 已持久化后，后续 post-check、lifecycle、tracking、ledger 或 snapshot 失败时，失败原因应写入或刷新该插件的 native recovery state；如果进程在具体失败原因形成前退出，保留 `pending_after_native_write` 中间态。只要 AW 自己的 rollback 没留下跨插件不确定性，`installed.json.ledgerState.status` 应保持或恢复为 `available`。
- repair install 成功后，AW 必须写入成功 scope record、tracking 和 install snapshot，并删除对应 native recovery state。此时如果没有其它独立 health 降级条件，`aw status` 必须回到 `ready`；实现不能通过 `preserveLedgerState()` 之类的逻辑把本次已修复的 native write 失败继续保留成全局 degraded。
- breadcrumb-only uninstall 成功后，AW 必须删除对应 native recovery state。此时如果 cache、目标 config entry、成功 scope record、shared native ref、tracking 和 breadcrumb 都已清理，且没有其它独立的全局 ledger 损坏，`aw status` 必须回到 `notInstalled`。
- 全局 `ledgerState.status = degraded` 只表示整份 installed ledger 的可信度不明，不能作为某个插件 native side effect 的唯一恢复真值。repair install 或 breadcrumb-only uninstall 不能擅自清掉与当前插件无关的全局 degraded；如果命令启动时已经存在这种独立 degraded，命令应沿用现有 degraded 安全策略要求显式选项、拒绝高风险继承或输出诊断，但不能把它当成本插件恢复未完成。

#### breadcrumb-only repair install

当 `codex / user / <plugin>@aw` 只有 native recovery breadcrumb、没有成功 scope record / shared native refs 时，显式 `aw install <plugin> -p codex -s user` 是受支持的修复路径。要求如下：

- install 命令不能把 breadcrumb 当成成功安装账本，也不能从 breadcrumb 继承 install options、lifecycle snapshot 或旧 receipt。
- 命令必须按当前 catalog 和本次 CLI 参数解析安装选项；如果用户没有显式传入可覆盖选项，就使用正常 fresh install 的默认值。
- 命令必须重新走 `ensureLocalMarketplace()`、marketplace 注册、app-server `plugin/install` 和 enabled/cache post-check。即使 native cache 或 enabled 已经存在，也不能跳过 `plugin/install`，因为这一步负责把 Codex cache 刷到当前 `~/.aw` bundle。
- 重新走 `ensureLocalMarketplace()` 时不能破坏用于授权本次 repair 的 breadcrumb。若本地 marketplace 因 CLI 升级、`aw init --force` 或 bundle fingerprint 变化而刷新，刷新完成后仍必须能读到同一个 `codex / user / <plugin>@aw` breadcrumb，直到 repair install 全部成功并由正常流程删除它。
- 只有 AW 后续 lifecycle、tracking、ledger 和 install snapshot 都成功写入后，才能把这次 repair install 视为成功，并删除对应 native recovery breadcrumb。
- repair install 成功写出的 ledger 必须是成功安装账本，并且不能继续携带由这条 breadcrumb 对应的 native write 失败产生的全局 degraded。若命令启动时存在与当前插件无关的全局 degraded，不能在 repair 成功时顺手清掉。
- 如果 repair install 在 `plugin/install` 成功后再次失败，必须保留或更新 breadcrumb 的失败原因；不能写成功 ledger，也不能把状态报告成 ready。
- 如果当前 catalog 已经找不到该插件，显式 install 不能消费 breadcrumb 猜测安装内容，必须失败并提示用户用 `aw uninstall <plugin> -p codex -s user` 清理残留。

### Codex User Scope 升级

`aw upgrade <plugin> -p codex -s user` 对需要 native runtime 的插件也必须调用同一条 `plugin/install` 路径。

原因是 AW 的本地 marketplace 可能已经刷新到新 bundle；即使插件 manifest version 没变，重新执行 Codex install 也能让 Codex cache 里的内容与当前 `~/.aw` 对齐。

但 breadcrumb-only 状态不能进入 upgrade 流程。显式 `aw upgrade <plugin> -p codex -s user` 如果发现目标只有 native recovery breadcrumb、没有成功 scope record / shared native refs，必须在执行 upgrade lifecycle、安装选项继承或 app-server `plugin/install` 之前失败。错误文案要说明当前安装未完成，建议先运行 `aw install <plugin> -p codex -s user` 修复，或运行 `aw uninstall <plugin> -p codex -s user` 清理后重装。

`aw upgrade --all -p codex -s user` 也必须排除 breadcrumb-only 目标。该目标不得进入 ready target，不得从 breadcrumb 继承 install options，不得运行 upgrade lifecycle，也不得调用 app-server `plugin/install`。命令应把它记录为 skipped，并给出同样的恢复建议：先运行显式 `install` 修复未完成安装，或运行 `uninstall` 清理 Codex native 残留。

### Codex User Scope 卸载

当目标插件在 Codex user scope 下需要 native plugin runtime，且 AW 按本次卸载移除目标 scope ref 后判断当前插件没有剩余 shared native refs 时，卸载必须走 Codex app-server `plugin/uninstall`。如果目标没有成功 scope record，但存在匹配的 native recovery breadcrumb，该 breadcrumb 也足以授权进入同一条卸载路径：

```json
{"id":"init-1","method":"initialize","params":{"clientInfo":{"name":"aw","version":"<aw-version>"},"capabilities":{}}}
{"method":"initialized"}
{"id":"uninstall-1","method":"plugin/uninstall","params":{"pluginId":"<plugin-name>@aw"}}
```

`plugin/uninstall` 由 Codex 负责删除 `~/.codex/plugins/cache/aw/<plugin>/...` 并清理用户级 `[plugins."<plugin>@aw"]` 配置。AW 不应继续把 `removeCodexPluginEnabledFile()` 当成 Codex user native 卸载主路径；它最多只能用于清理 AW 自己管理且不需要 native runtime 的兼容路径，不能绕过 cache 清理。

卸载成功后必须做轻量 post-check：用户级 `[plugins."<plugin>@aw"]` config entry 已不存在，并且 `~/.codex/plugins/cache/aw/<plugin>/...` 下没有 active cache 版本。只有 post-check 通过，才能认为 native uninstall 完成。`enabled = false` 的残留 entry 不能算通过，因为 Codex 官方卸载路径应删除整条 plugin entry。

如果当前插件仍有 shared native refs，AW 不调用 `plugin/uninstall`，也不能删除 Codex cache / enabled。等最后一个 ref 被移除时，再调用 `plugin/uninstall`。

`[marketplaces.aw]` 的清理条件必须同时满足下面这些条件：

- 所有插件的 AW native plugin shared refs 都不存在。
- 所有插件级 native recovery breadcrumb 都不存在。
- 用户级 Codex config 中不存在任何 `[plugins."<plugin>@aw"].enabled = true` entry。
- `~/.codex/plugins/cache/aw/` 下不存在任何插件 active cache 版本。

换句话说，某个插件只有 breadcrumb、enabled config-only 或 cache-only evidence、没有成功 scope record / shared native refs 时，仍然是 AW 需要暴露或恢复处理的 native 证据。卸载另一个插件时不能因为 refs 已空就提前删除 `[marketplaces.aw]`，否则会把剩余插件的现场变成“marketplace 已注销但 native 残留仍在”的半失配状态。AW 不能把无归属 enabled config-only / cache-only evidence 当成可清理的 managed state；status 和交互候选应继续展示这些残留，并提示缺少 AW 归属证据。单独的 disabled config entry 不进入这套 evidence 模型；只有在当前目标刚执行 `plugin/uninstall` 时，post-check 才需要把 disabled entry 残留视为卸载未清干净。

`plugin/uninstall` 已按 Codex 当前实现设计为幂等：目标 cache 或 config entry 已经不存在时，成功响应仍可视为卸载成功。但如果 app-server 启动失败、方法不可用、请求失败，或 post-check 发现 cache / 目标 plugin config entry 仍存在，`aw uninstall` 必须失败，不能退回到“只删 enabled”的假成功。此时 ledger / tracking 不得写成已干净卸载，`aw status` 应继续暴露残留 native evidence。

如果 install 曾在 native write 成功后失败并留下 native recovery breadcrumb，显式或交互式 `aw uninstall` 必须把该 breadcrumb 当作恢复授权证据：它不代表成功安装，但足以证明 AW 需要清理 `codex / user / <plugin>@aw` 的 native side effect。卸载完成后必须删除 breadcrumb；如果当前 native evidence 已经被用户手动清掉，`plugin/uninstall` 的幂等成功和 post-check 通过后也应删除 breadcrumb。只要没有其它独立的全局 ledger 损坏或外部证据，status 必须回到 `notInstalled`，不能继续受这次已清理的 native write 失败影响。

breadcrumb-only 卸载的 lifecycle 语义必须保持保守：

- 当卸载目标只有 native recovery breadcrumb、没有成功 scope record / shared native refs / install snapshot 时，AW 不运行插件自己的 `uninstall` lifecycle。
- breadcrumb 不能作为 `getScopeRecordForUninstall()` 的替代输入，也不能触发 lifecycle resolver 回退到 current catalog 去查找并执行 uninstall script。
- 该路径只执行 Codex app-server `plugin/uninstall`、cache / config-entry post-check、breadcrumb 删除，以及必要的 marketplace 清理判断。
- 如果存在成功 scope record，并且按正常 managed uninstall 流程需要执行 lifecycle，则继续使用既有 lifecycle 语义；单独的 shared native ref 或 breadcrumb 不能提升为这种成功安装证据。

### Codex Project Scope 隔离

Codex project scope 必须保持现有 repo-managed 语义：

- 不调用 `codex plugin marketplace add`。
- 不启动 app-server `plugin/install` / `plugin/uninstall`。
- 不写 `~/.codex/config.toml [plugins]`。
- 不写 `~/.codex/config.toml [marketplaces]`。
- 不写 `~/.codex/plugins/cache/...`。
- 只写当前仓库内的 `.agents/skills`、`.codex/config.toml`、`.codex/hooks.json`、`.codex/rules`、`.codex/agents` 和 `.codex/.agent-workflows-manifest.json`。

当前代码中的 `requiresCodexNativePlugin(plugin, 'project') === false` 是正确边界，必须保留。`mayWriteNativeState()` 对 Codex project repo-managed target 应继续返回 false。

如果用户把纯 native-only 插件安装到 Codex project scope，AW 应失败并提示改用 user scope。包含 `apps` 的 Codex project scope 仍然 fail fast。

这里的“纯 native-only”指只有 Codex native plugin runtime 能承载、没有任何 project-managed artifacts 的插件，不包含 `extensions.nativeHooks.codex`。Codex project scope 下的 `nativeHooks` 仍属于 repo-managed hook，会写入当前仓库 `.codex/hooks.json`。

## 错误处理

### app-server 启动失败

如果找不到 `codex`、app-server 无法启动、stdio 关闭或超时，安装或卸载失败。错误文案要说明：

- AW 没有完成 Codex native plugin 安装或卸载。
- 需要安装或升级 Codex CLI。
- 不会回退到只写或只删 `config.toml`。

### RPC 方法不可用

如果 `plugin/install` / `plugin/uninstall` 返回 unknown method、invalid request 或类似协议错误，命令失败。错误文案要提示当前 Codex 版本可能没有开放 app-server 插件安装/卸载接口，需要升级 Codex。

### Codex plugins feature 禁用

如果 app-server 返回 `Codex plugins are disabled for this workspace`，安装失败。错误文案要提示启用 Codex plugins feature，而不是把 AW 状态写成成功。

### marketplace 或插件不可安装

如果 marketplace path 不存在、manifest 解析失败、插件不存在，或 install policy 为不可安装，安装失败。AW 不得写入 enabled 兜底。

### native install 成功后的 AW 后续失败

`plugin/install` 成功返回后，AW 必须在进入 cache / enabled post-check、lifecycle、tracking、ledger、install snapshot 写入或 snapshot GC 前先写入或刷新插件级 native recovery breadcrumb。如果 breadcrumb 写入失败，命令必须立即失败，不继续执行后续阶段。如果 breadcrumb 已经写入，而 post-check、lifecycle、tracking、ledger 或 install snapshot 写入失败，本轮不做 native rollback。要求如下：

- 命令必须返回失败，不能输出成功 receipt。
- 不写入新的成功 ledger；如果 breadcrumb 已经成功持久化，不能再仅因 `nativeWritten === true` 把全局 ledger 标成 degraded。失败 reason 应写入或刷新插件级 native recovery state。
- breadcrumb 写入失败时，错误文案要说明 AW 未能持久化恢复证据，不能把状态伪装成可自动恢复，也不能承诺后续 `aw install` repair 或 `aw uninstall` 一定会被自动授权。
- breadcrumb 已成功写入后的后续失败，必须保留插件级 native recovery breadcrumb。breadcrumb 的写入时序必须早于所有 AW 后续可失败步骤；只写全局 `ledgerState.reason = operation_interrupted_after_native_write` 不够，因为它不能证明哪个插件、哪个 scope 的 native side effect 需要恢复。
- AW 只回滚自己写入或能安全恢复的 artifacts / tracking / snapshots，不调用 `plugin/uninstall` 清理 Codex cache 或 enabled config。
- 如果 breadcrumb 写入失败、installed ledger 本身无法恢复、tracking rollback 失败，或实现无法确定失败只影响当前插件，才允许把全局 `ledgerState.status` 标成 degraded。此时错误文案必须说明这是全局账本可信度问题，不能承诺 repair install 或 breadcrumb-only uninstall 会自动清掉该 degraded。
- 错误文案要说明 Codex native 状态可能已经改变。若 breadcrumb 已成功写入，提示用户用 `aw status --verbose` 查看 partial / needsAttention 状态，或用 `aw uninstall <plugin> -p codex -s user` 清理残留；若 breadcrumb 写入失败，只能提示用户查看 `aw status --verbose` / debug log 并按 Codex 原生状态人工判断，不能暗示 AW 已持有可自动清理的恢复授权。
- 后续如果要提供强原子 rollback 或自动 repair 语义，需要单独补充 spec。存在成功 managed evidence 或 breadcrumb 授权时，正常 `aw uninstall` 仍必须按本 spec 使用 `plugin/uninstall` 清理 native 状态。

### breadcrumb-only 下的显式 install / upgrade

breadcrumb-only 状态下，显式 `aw install <plugin> -p codex -s user` 是 repair install；它重新执行 native install 和 AW 安装流水线，成功后补齐 ledger / tracking / snapshot 并删除 breadcrumb。

显式 `aw upgrade <plugin> -p codex -s user` 必须失败，不能把 breadcrumb 当成 managed evidence、fallback evidence 或安装时快照。错误文案要给出两条恢复路径：运行 `aw install` 修复未完成安装，或运行 `aw uninstall` 清理 Codex native 残留。

`aw upgrade --all -p codex -s user` 必须把 breadcrumb-only 目标作为 skipped target 处理，并输出同样的修复/清理建议。它不能因为 discovery 合并了 breadcrumb evidence，就把该目标加入 ready target 或触发 app-server `plugin/install`。

## 状态判定

Codex user scope 的 status 需要把 native 状态拆开：

- `enabled`：来自用户级 `~/.codex/config.toml [plugins."<plugin>@aw"].enabled === true`。缺少 config entry 或 `enabled` 不为 `true` 都按 `enabled === false` 处理；单独的 disabled config entry 不作为 native evidence。
- `installed`：默认只来自本地只读证据，也就是 `~/.codex/plugins/cache/aw/<plugin>/<version>` 是否存在 active cache 版本。
- `native recovery`：来自 AW 写入的插件级恢复 breadcrumb，只表示“AW native write 已发生但安装未完成或清理未完成”，不等同于成功安装。
- `ledger degraded`：来自全局 `installed.json.ledgerState.status = degraded`，只表示整份 ledger 可信度不明。它会降级 health，但不是某个 Codex native 插件的恢复授权来源。

`status` 仍必须保持纯本地只读语义：不启动 app-server、不刷新 marketplace、不创建配置目录。app-server `plugin/list` 只能作为 debug、诊断或测试交叉校验手段，不能成为默认真值来源。

现有 JSON 字段 `native.pluginInstalled` 不能继续等同于 config enabled。本轮接受破坏性语义变更：

- `native.pluginInstalled` 表示 cache installed。
- 新增 `native.pluginEnabled` 表示用户级 config enabled。
- JSON 需要新增或复用稳定字段表达 native recovery breadcrumb 是否存在、是否匹配当前 native evidence，以及恢复建议；这个字段不能被消费者理解为成功 installed。
- `--json` 的 schema 文档和测试必须同步更新，明确这是一次语义 breaking change，不提供旧语义过渡期。

Codex user native plugin 的 `ready` 判定必须同时满足：

- `installed === true`
- `enabled === true`
- 当前 scope 有成功 scope record 这类完整 AW managed evidence
- 不存在 native recovery breadcrumb、全局 degraded ledger、catalog capability drift、外部同名冲突或其它已有 health 降级条件

`shared native ref` 只能证明 AW 仍需要保守维护某个 Codex user native runtime，不能单独证明当前 scope 已经完整安装成功。若当前 scope 没有成功 scope record，即使 cache installed 和 config enabled 都存在，也不能判为 `ready`，也不能作为 `upgrade --all` 的 ready target 或 install options / lifecycle snapshot 继承来源。

native write 后失败在本 spec 下应主要通过 native recovery breadcrumb 让目标进入 `needsAttention`。全局 degraded ledger 仍会让 status 降级，但它表示“账本整体不可信”，不能代替插件级恢复状态；repair install 或 breadcrumb-only uninstall 成功后，只能清掉当前插件的 native recovery state，不能误清其它全局 degraded 原因。

`installed` / `enabled` 拆分后的状态机必须覆盖下面这些组合：

| installed | enabled | AW evidence | 默认 health | 要求 |
|-----------|---------|-------------|-------------|------|
| `true` | `true` | 成功 scope record | `ready`，除非其它 health 规则降级 | 显示为可用 |
| `true` | `true` | 只有 shared native ref、没有成功 scope record | `needsAttention` | cache 和 config 都存在，但当前 scope 缺少完整成功账本；不能显示 `ready`，不能进入 `upgrade --all` ready target |
| `true` | `true` | native recovery breadcrumb | `needsAttention` | 提示安装未完成，可运行 `aw install <plugin> -p codex -s user` 修复，或运行 `aw uninstall <plugin> -p codex -s user` 清理后重装 |
| `true` | `false` | 任意 | `needsAttention` | cache 仍在但 config 未启用，不能显示 `ready`；默认输出要点名 cache-only 残留 |
| `false` | `true` | 任意 | `needsAttention` | config 已启用但 cache 缺失，提示 Codex 原生插件未完成安装 |
| `false` | `false` | 成功 scope record、shared native ref 或 breadcrumb | `needsAttention` | AW 仍有未清理或无法确认的管理证据，不能直接隐藏成未安装 |
| `false` | `false` | 无成功 evidence 且无 breadcrumb | `notInstalled` | 卸载完成后的目标状态 |

如果全局 ledger degraded 存在，以上任意组合都还要按现有 health 规则降级为 `needsAttention` 或 `unknown`，并在输出中明确它是独立的账本可信度问题，不是当前插件可通过 breadcrumb-only cleanup 清掉的 native recovery state。

`--verbose` / JSON 里应保留 enabled、installed、active cache path、config path、marketplace health、breadcrumb、recovery reason 和全局 ledger reason，方便排查。若 install 命令失败但 native side effect 已经存在，status 也要能把“cache/enabled 存在”和“AW ledger/tracking 未完成 / breadcrumb 存在 / 全局 ledger degraded”分开显示。正常 user scope 卸载完成后，如果 cache、目标 config entry、ledger/tracking 和 breadcrumb 都已清理，且没有其它全局 ledger degraded，`aw status` 必须回到 `notInstalled`，不能因为旧 cache 残留落到 `partial`。

### Discovery 与交互候选

默认 discovery 不能只扫描 Codex user config 里的 enabled 插件。Codex user scope 至少要合并三类本地只读 evidence：

- 用户级 config 中 `[plugins."<plugin>@aw"].enabled = true`；disabled config entry 不单独进入 discovery 候选。
- `~/.codex/plugins/cache/aw/<plugin>/...` 下的 active installed cache 版本，即使 config 已关闭或不存在。
- AW ledger / tracking / native recovery breadcrumb。

这些 evidence 都要进入 `aw status` 的候选构建；交互式 `aw uninstall` 也要能列出 cache-only 或 breadcrumb-only 的 Codex user native 残留。执行卸载时仍要遵守安全边界：成功 managed evidence 或 native recovery breadcrumb 可以授权调用 `plugin/uninstall`；只有 cache evidence、但没有 AW managed evidence / breadcrumb 时，status 必须展示残留，交互候选必须提示无法证明归属，执行型命令不能静默删除不受管状态。

## 实现建议

新增一个私有 Codex app-server client，例如：

```text
packages/cli/src/utils/codex-app-server-client.ts
```

职责：

- spawn `codex app-server`。
- 按行写入 JSON request/notification。
- 按行读取 JSON response，忽略无关 notification，按 `id` 匹配响应。
- 支持 timeout、stderr capture、子进程清理。
- 把 JSON-RPC error 转成 AW 可读错误。
- 暴露最小 API：
  - `installCodexPluginViaAppServer({ marketplacePath, pluginName, cwd, env, nativeCliRunner? })`
  - `uninstallCodexPluginViaAppServer({ pluginId, cwd, env, nativeCliRunner? })`

为了测试注入，可以复用现有 `NativeCliRunner` 思路，或新增更适合长生命周期 stdio 的 runner 抽象。不要把 app-server 交互硬编码成不可测试的 `child_process.spawn()`。

`CodexAdapter.installPlugin()` 的目标结构：

```text
project scope:
  只做 project installability preflight，然后 return

user scope + 不需要 native:
  return

user scope + 需要 native:
  ensureLocalMarketplace()
  ensure marketplace registered
  install via app-server plugin/install
  write or refresh native recovery breadcrumb(state: pending_after_native_write)
  verify enabled + cache
```

`CodexAdapter.uninstallPlugin()` 的目标结构：

```text
project scope:
  只删除 repo-managed artifacts；不触碰 user native state

user scope + 不需要 native:
  return

user scope + 当前插件仍有 shared native refs:
  return

user scope + 当前插件没有剩余 shared native refs，且有成功 managed evidence 或 native recovery breadcrumb:
  uninstall via app-server plugin/uninstall(pluginId: "<plugin>@aw")
  verify plugin config entry gone + cache gone
  如果没有任何 @aw 插件级 native evidence（shared refs、breadcrumb、enabled config entry、active cache），清理 marketplaces.aw
```

`commands/uninstall.ts` 在进入 lifecycle 之前必须先区分授权来源：成功 managed evidence 走正常 managed uninstall lifecycle；breadcrumb-only 只走 native recovery cleanup，并显式跳过 `runLifecycleScript(event: 'uninstall')`。实现不能让 breadcrumb-only 通过 `getScopeRecordForUninstall()`、fallback evidence 或 current catalog 回退间接触发 uninstall script。

post-check 和 status 都应使用本地只读 helper 解析 config enabled 与 cache installed；uninstall post-check 还必须能判断目标 plugin config entry 是否仍然存在。不要为了 status 默认路径复用 app-server client；app-server client 只服务写入型 install / upgrade / uninstall，或显式 debug 校验。

失败处理要复用当前安装事务边界：native write 成功后的 AW 后续失败不触发 native rollback。实现需要把这类失败标记成“native write 后失败”，并确保 ledger 不会被写成成功安装。这里不能只写全局 degraded reason；还要在 `plugin/install` 成功返回后、任何 post-check / lifecycle / tracking / ledger / snapshot 步骤前写入或刷新插件级 native recovery breadcrumb，并让 discovery / status / uninstall 能读到它。不能把 breadcrumb 写入推迟到统一 catch / rollback 分支。当前 `preserveLedgerState()` 和 rollback 中按 `nativeWritten` 写全局 degraded 的逻辑需要收窄：breadcrumb 已持久化且 rollback 未留下跨插件不确定性时，不应产生或保留全局 degraded；repair install / breadcrumb-only uninstall 成功后也不能继续继承这类已愈合状态。如果 breadcrumb 主写入失败，不能把 enabled config/cache evidence 临时提升成 managed evidence 来绕过 historical uninstall 保护；该分支可以进入全局 degraded 或只读诊断，但自动 repair / uninstall 授权必须缺席。

实现 breadcrumb 存储时还必须接入本地 marketplace 刷新的保留合同。若存储根在 `~/.aw` 内，`initializeLocalMarketplace()` 的 staging / preserve / `replaceDirectoryAtomically()` 流程必须像保留 `plugin-config/` 和 `plugin-install-snapshots/` 一样保留该目录或文件；若存储根在 `~/.aw` 外，相关 helper 要明确解析该外部路径，避免 repair install 第一步刷新 `~/.aw` 时删除恢复证据。布局校验和 bundle fingerprint 计算不能把 breadcrumb 当成 embedded bundle 的一部分。

Codex native evidence helper 需要同时读取用户级 config enabled 和 cache installed：

```text
readCodexNativePluginState(pluginName):
  configEntryPresent = ~/.codex/config.toml [plugins."<plugin>@aw"] exists
  enabled = configEntryPresent && [plugins."<plugin>@aw"].enabled === true
  installed = active cache version exists under ~/.codex/plugins/cache/aw/<plugin>/
  activeCachePath = resolved active version path, if any
```

`commands/discovery.ts` 的 Codex user native 扫描应同时加入 enabled config evidence、cache evidence 和 native recovery breadcrumb evidence。`commands/status.ts` 的 health resolver 不能再把 `native.pluginInstalled` 单独当成 ready runtime evidence；对 Codex user native plugin，ready 之前必须先确认 cache installed 与 config enabled 同时成立。

`commands/install.ts` 遇到 breadcrumb-only Codex user target 时，应按 repair install 处理：不从 breadcrumb 继承旧 install options，不要求已有成功 scope record，但必须在成功完成 AW 安装流水线后删除 breadcrumb。`commands/upgrade.ts` 遇到同一状态时必须提前拒绝；显式 upgrade 直接失败，`upgrade --all` 记录 skipped。两条路径都不能让 fallback evidence 或 breadcrumb 推动 upgrade lifecycle、安装选项继承或 app-server `plugin/install`。

### 同步更新面

实现本 spec 时，除了代码和测试，还必须同步检查这些文档和作者工具：

- `docs/architecture.md` 中 Codex user scope native 安装流程的描述。
- `docs/plugin-installation.md` 中 `--scope user` 的 Codex 注意事项、`aw status --json` schema 说明和故障排查。
- `docs/plugin-authoring.md` 中 Codex user/project scope 对插件作者的影响说明。
- `docs/testing.md` 中 Codex native marketplace / app-server RPC 测试约定。
- `.agents/skills/create-agent-workflows-plugin/` 下与插件作者使用方式有关的技能说明、模板、示例和测试夹具。

## 测试要求

### Unit

- Codex user scope native install 会调用 app-server installer，而不是只调用 `upsertCodexPluginEnabledFile()`。
- app-server install 成功后，缺少 cache post-check 时整体失败。
- `plugin/install` unknown method 时失败，不写 config-only fallback。
- marketplace add 失败时失败，不启动 install RPC。
- 已注册 canonical marketplace 时不重复调用 marketplace add，但仍调用 `plugin/install`。
- status 中 config enabled 但 cache missing 时，Codex user scope 不能显示为 installed。
- status 中 cache installed 但 config disabled / missing 时，Codex user scope 不能显示为 ready，必须显示需要处理的 cache-only 残留。
- Codex user native plugin 只有 `installed=true` 且 `enabled=true` 时才可能是 ready；任一侧缺失都必须降级。
- Codex user native plugin 即使 `installed=true` 且 `enabled=true`，如果只有 shared native ref、没有成功 scope record，也不能显示为 ready，不能进入 `upgrade --all` ready target。
- status 默认路径只能读取本地 config/cache/ledger/tracking 证据，不能启动 app-server 或依赖 `plugin/list`。
- discovery 会扫描 `~/.codex/plugins/cache/aw/<plugin>/...` active cache 版本；cache-only 插件会进入 `aw status` 和交互式 uninstall 候选。
- `aw status --json` 中 `native.pluginInstalled` 表示 cache installed，并新增 `native.pluginEnabled`；测试需要锁住这次 breaking change 的新语义。JSON 还要表达 native recovery breadcrumb 的存在与恢复建议。
- native recovery breadcrumb 有独立于 `installed.json` 主体完整性的读取路径；当 `installed.json` 缺失或结构无效并被重建为空 degraded ledger 时，discovery、status、uninstall 和 marketplace cleanup 仍能发现尚未恢复的 breadcrumb。
- native recovery breadcrumb 能跨本地 marketplace 刷新保留：在 breadcrumb-only 状态下触发会重建 `~/.aw` 的 `ensureLocalMarketplace()`，或执行等价的 `aw init --force` / bundle refresh 后，discovery、status、repair install、uninstall 和 marketplace cleanup 仍能读取同一个 breadcrumb。
- `plugin/install` 成功后会先写入插件级 native recovery breadcrumb，再进入 post-check、lifecycle、tracking 或 ledger；初始 breadcrumb 使用 `pending_after_native_write` 之类的中间态，后续步骤失败时命令失败，不写成功 ledger，并把 breadcrumb 刷新为具体失败原因；错误与 status 能提示 native side effect 可能已存在。
- 只有 `pending_after_native_write` 中间态、还没有具体失败 reason 的 breadcrumb 也必须被 status、repair install 和 breadcrumb-only uninstall 当成有效恢复证据。
- `plugin/install` 成功但 breadcrumb 写入失败时，命令立即失败，不进入 post-check、lifecycle、tracking 或 ledger；错误文案说明 AW 缺少恢复证据，不能承诺后续 `aw install` repair 或 `aw uninstall` 自动授权清理。该状态下仅有 enabled config/cache evidence 时，historical uninstall 保护仍按无受管证据处理。
- breadcrumb 已成功持久化且 rollback 没留下跨插件不确定性时，native write 后的 AW 后续失败不会把全局 `installed.json.ledgerState.status` 写成 degraded；status 的降级来自插件级 native recovery state。
- 在 `plugin/install` 成功、breadcrumb 已持久化、但 AW 后续步骤失败后继续执行 `aw uninstall <plugin> -p codex -s user`，不能被 historical uninstall 保护提前拒绝，必须调用 app-server `plugin/uninstall` 并在 post-check 成功后删除 breadcrumb。
- breadcrumb-only 状态下执行 `aw uninstall <plugin> -p codex -s user`，即使当前 catalog 声明了 uninstall lifecycle script，也不能运行该 script；命令只清理 Codex native cache / config entry 和 breadcrumb。
- breadcrumb-only 状态下显式 `aw install <plugin> -p codex -s user` 会作为 repair install 重新调用 app-server `plugin/install`，成功后补齐 ledger / tracking / install snapshot 并删除 breadcrumb；若没有其它全局 ledger 损坏，`installed.json.ledgerState.status` 为 `available`，status 回到 `ready`。
- breadcrumb-only 状态下显式 `aw uninstall <plugin> -p codex -s user` 成功后，如果 cache、目标 config entry、scope record、shared native refs、tracking 和 breadcrumb 都已清理，且没有其它全局 ledger 损坏，status 回到 `notInstalled`。
- breadcrumb-only 状态下显式 `aw upgrade <plugin> -p codex -s user` 必须在进入 upgrade lifecycle、安装选项继承或 app-server `plugin/install` 前失败，并提示先 `install` 修复或 `uninstall` 清理。
- breadcrumb-only 状态下 `aw upgrade --all -p codex -s user` 必须把目标记为 skipped，不能加入 ready target，不能继承 install options，不能运行 upgrade lifecycle，也不能调用 app-server `plugin/install`；skipped reason 需要提示先 `install` 修复或 `uninstall` 清理。
- Codex user scope native uninstall 在没有剩余 shared native refs 时调用 app-server `plugin/uninstall`，而不是只调用 `removeCodexPluginEnabledFile()`。
- `[marketplaces.aw]` 只有在没有任何 `@aw` 插件级 native evidence（shared refs、breadcrumb、enabled config entry、active cache）时才会被删除；存在其它插件的 breadcrumb、enabled config-only 或 cache-only 残留时，卸载当前插件不能提前删除 marketplace。
- `plugin/uninstall` 成功后如果 cache 或目标 plugin config entry post-check 仍存在，卸载命令失败，不把 ledger / tracking 写成干净卸载。
- discovery/status 不把仅有 `enabled = false` config entry、且没有 cache / breadcrumb / managed evidence 的插件列为候选；marketplace cleanup 也不因这种 disabled-only entry 保留 `[marketplaces.aw]`。
- `plugin/uninstall` unknown method 或返回失败时，卸载命令失败，不做 config-only fallback。
- Codex user scope 先 native install 再 native uninstall 后，status 没有 runtime evidence，健康状态回到 `notInstalled`。
- 仍有 shared native refs 时，Codex user scope uninstall 不调用 `plugin/uninstall`，不删除 cache / enabled。
- Codex project scope skills/MCP/slashCommands/extensions install 不调用 marketplace add，不调用 app-server install。
- Codex project scope uninstall 不调用 app-server `plugin/uninstall`，不删除用户级 Codex cache / enabled。
- Codex project scope 没有 project-managed artifacts 的 native runtime-only 插件拒绝安装。
- Codex project scope apps 插件拒绝安装。

### Integration

- `aw install git-commit -p codex -s user` 后，断言：
  - `~/.codex/config.toml` 有 `[plugins."git-commit@aw"].enabled = true`
  - `~/.codex/plugins/cache/aw/git-commit/<version>` 存在
  - `aw status --verbose` 不再把插件报告成 enabled 但未安装
- 模拟 app-server 启动失败、方法不可用或 `plugin/install` 返回失败，断言命令非 0，stderr 有可行动错误，AW 不写 config-only fallback。
- 模拟 `plugin/install` 已成功、breadcrumb 已写入、但 AW 后续步骤失败，断言命令非 0，ledger 不记录成功安装；如果 native enabled/cache 已经存在，`aw status --verbose` 能显示 partial / needsAttention 诊断，而不是报告为完全 ready；在 rollback 没留下跨插件不确定性的 fixture 中，全局 `ledgerState.status` 仍为 `available`。
- 模拟 `plugin/install` 已成功、但 breadcrumb 写入失败，断言命令非 0，未进入 cache / enabled post-check 或任何 AW 后续写入步骤；stderr / debug log 明确说明缺少恢复证据，不提示 `aw uninstall` 已可自动清理；随后只有 enabled config/cache evidence、没有成功 managed evidence / breadcrumb 时，执行型 uninstall 仍不会绕过 historical uninstall 保护。
- 模拟 `installed.json` 缺失或结构无效并被 CLI 重建为空 degraded ledger，断言已有 native recovery breadcrumb 仍能被 status / discovery / uninstall / marketplace cleanup 读取，且不会因为 ledger 重建而丢失恢复授权。
- 模拟 breadcrumb-only 状态下先触发一次会刷新 `~/.aw` 的 `ensureLocalMarketplace()`，再执行显式 repair install，断言 breadcrumb 没有在 repair 第一步被删除，命令仍能调用 `plugin/install` 并在成功后按正常流程删除 breadcrumb。
- 模拟存在 native recovery breadcrumb 后执行 `aw init --force` 或等价 bundle refresh，断言 status / discovery / uninstall / marketplace cleanup 仍能读取该 breadcrumb；如果最后一个可证明归属的插件只剩 breadcrumb，刷新后也不能提前删除 `[marketplaces.aw]`。
- 在 breadcrumb-only 状态下执行显式 `aw install git-commit -p codex -s user`，断言命令重新调用 `plugin/install`，成功后写入 ledger / tracking / install snapshot，并删除 native recovery breadcrumb；随后 `aw status --verbose` 报告 `ready`，`installed.json.ledgerState.status` 为 `available`。
- 在 breadcrumb-only 状态下执行显式 `aw upgrade git-commit -p codex -s user`，断言命令失败且不会进入 upgrade lifecycle、不会继承旧 install options、不会调用 app-server `plugin/install`。
- 在 breadcrumb-only 状态下执行 `aw upgrade --all -p codex -s user`，断言目标被记录为 skipped，不进入 ready target，不继承 install options，不运行 upgrade lifecycle，也不调用 app-server `plugin/install`；输出提示先 `install` 修复或 `uninstall` 清理。
- 在 `plugin/install` 已成功但 AW 后续步骤失败的 breadcrumb 场景后执行 `aw uninstall git-commit -p codex -s user`，断言命令真正进入 `plugin/uninstall`，不会运行插件 uninstall lifecycle，清理 `~/.codex/config.toml` 和 `~/.codex/plugins/cache/aw/git-commit`，并删除 native recovery breadcrumb；随后 `aw status --verbose` 报告 `notInstalled`，`installed.json.ledgerState.status` 为 `available`。
- 模拟 breadcrumb-only 目标当前 catalog 声明了 uninstall script，断言该 script 不会被执行，且 lifecycle resolver 不会因为缺少 install snapshot 回退到 current catalog。
- 模拟两个 Codex user 插件都留下 native recovery breadcrumb、且都没有成功 scope record / shared native refs；先卸载其中一个并清掉它的 breadcrumb 后，断言 `[marketplaces.aw]` 仍保留，直到最后一个 breadcrumb 也被清理。
- 模拟另一个 `@aw` 插件只剩无归属 enabled config-only 或 cache-only evidence；卸载当前最后一个可证明归属的 managed 插件后，断言 `[marketplaces.aw]` 仍保留，status 继续展示该无归属残留而不是静默清理。
- 模拟命令开始前已经存在与当前插件无关的全局 degraded ledger，断言 repair install 或 breadcrumb-only uninstall 不会把该 degraded 当成本插件恢复完成而清掉，status 仍明确提示全局账本可信度问题。
- 手动制造 cache-only 状态（cache active version 存在、config disabled / missing），断言默认 `aw status` 能发现该插件并报告 `needsAttention`；交互式 uninstall 候选包含该插件，但没有 managed evidence / breadcrumb 时不能静默清理。
- `aw uninstall git-commit -p codex -s user` 在 install 成功后执行，断言：
  - `~/.codex/config.toml` 不再有 `[plugins."git-commit@aw"]`
  - `~/.codex/plugins/cache/aw/git-commit` 不再有 active installed 版本
  - `aw status --verbose` 报告 `notInstalled`，而不是 `partial`
- 模拟 `plugin/uninstall` 启动失败、方法不可用或返回失败，断言命令非 0，stderr 有可行动错误，AW 不写 config-only uninstall fallback，status 保留残留 native evidence。
- Codex project scope install 在 PATH 缺少 `codex` 时仍可完成 repo-managed 写入。
- Codex project scope install 完成后，断言 `~/.codex/config.toml` 和 `~/.codex/plugins/cache` 没有新增 AW 插件状态。

### Smoke

- `pnpm test:unit`
- `pnpm test:integration`
- 如实现影响 build bundle，补跑 `pnpm test:smoke:build`。

## 验收标准

- 用户只运行 AW install 就能让 Codex 原生插件立即生效。
- Codex 不再出现 AW 写入 enabled 但 runtime 报 `plugin is not installed` 的状态。
- 安装失败不会被 AW 记录成成功，也不会由 AW 写入 config-only enabled 兜底；若失败发生在 Codex native install 成功之后，允许保留 Codex 已写入的 native 副作用。breadcrumb 已成功持久化时，该状态必须能被 status 识别为 partial / needsAttention，而不是完全 ready；breadcrumb 已持久化且 rollback 可置信时，这类插件级失败不能把全局 `installed.json` 标成 degraded。若 breadcrumb 自身写入失败，AW 只承诺暴露缺少恢复证据的诊断，不承诺后续 repair / uninstall 自动授权。
- native recovery breadcrumb 具备独立于 `installed.json` 主体完整性的读取路径；`installed.json` 缺失、结构无效或被重建为空 degraded ledger 时，尚未恢复的 breadcrumb 仍能被 status、discovery、uninstall 和 marketplace cleanup 使用。
- native recovery breadcrumb 不会被本地 marketplace 刷新擦除；`ensureLocalMarketplace()`、`aw init --force`、bundle refresh 或 `~/.aw` 原子替换之后，尚未恢复的 breadcrumb 仍能支撑 repair install、uninstall、status 和 marketplace cleanup。
- breadcrumb-only 状态下，显式 `aw install <plugin> -p codex -s user` 能作为 repair path 补齐 AW 账本并删除 breadcrumb；若没有其它独立 health 降级条件，status 回到 `ready`，全局 ledger 为 `available`。显式 `aw upgrade <plugin> -p codex -s user` 会拒绝执行并提示先 install 修复或 uninstall 清理。
- breadcrumb-only 状态下，`aw upgrade --all -p codex -s user` 会把目标记录为 skipped，不进入 ready target，不继承 install options，不运行 upgrade lifecycle，也不调用 app-server `plugin/install`。
- native recovery breadcrumb 能授权后续正常 `aw uninstall <plugin> -p codex -s user` 清理 Codex cache / config entry；breadcrumb-only 卸载不会运行插件 uninstall lifecycle，卸载成功后 breadcrumb 被删除。若没有其它全局 ledger 损坏或外部证据，status 回到 `notInstalled`，全局 ledger 为 `available`。
- Codex user scope 的 native install 与 Codex 官方安装路径的副作用一致：cache materialized，config enabled。
- Codex user scope 的 native uninstall 与 Codex 官方卸载路径的副作用一致：cache removed，config plugin entry removed。
- `[marketplaces.aw]` 只有在所有 `@aw` 插件级 native evidence 都消失后才会被清理；无归属 enabled config-only / cache-only 残留不会被 AW 静默当成 managed state 删除，disabled-only config entry 不阻塞 cleanup。
- `aw install <plugin> -p codex -s user` 后再 `aw uninstall <plugin> -p codex -s user`，`aw status` 回到 `notInstalled`，不会留下 cache 导致的 `partial`。
- `aw status --json` 明确完成 breaking change：`native.pluginInstalled` 表示 cache installed，`native.pluginEnabled` 表示 config enabled。
- `aw status` 默认真值来自本地只读 evidence，不依赖 app-server `plugin/list`。
- `aw status` 和 discovery 会扫描 Codex cache active version；`installed=true && enabled=false`、`installed=false && enabled=true` 都不能显示为 ready。
- Codex project scope 不产生用户级 native 插件副作用。
- 默认输出和 debug log 能区分：
  - marketplace registration
  - app-server install RPC
  - app-server uninstall RPC
  - cache/materialization verification
  - project repo-managed skipped native

## 风险与后续

- `plugin/install` 和 `plugin/uninstall` 在 Codex app-server README 中仍标注 under development，未来协议可能变动。AW 需要把协议交互封装在单独模块，避免散落到 adapter。
- 如果 Codex 后续公开 `codex plugin install` / `codex plugin uninstall` CLI，可以把 app-server stdio client 替换为公开 CLI，但验收语义仍应保持：安装必须 materialize cache，卸载必须清理 cache 和 plugin config entry，不能只改 config。
- `codex app-server proxy` 可作为未来增强，但需要实现 WebSocket-over-UDS，而不是直接发送 JSONL。
- native install 成功后 AW 后续步骤失败时的强原子 rollback 仍是后续能力；本轮只在 native recovery breadcrumb 已成功持久化后，保证显式 `aw install` 能修复 AW 账本，显式 `aw uninstall` 能清理 Codex native cache 和 plugin config entry。breadcrumb 自身写入失败的自动恢复授权不在本轮范围。
