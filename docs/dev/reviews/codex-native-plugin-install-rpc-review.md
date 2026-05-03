# `codex-native-plugin-install-rpc.md` 需求复审报告

审查对象：`docs/dev/specs/codex-native-plugin-install-rpc.md`  
审查时间：2026-05-04

这轮复审重点看三件事：

- 需求现在是否合理，是否还有逻辑漏洞
- 方案在当前仓库基线下能不能落地
- 上一轮 review 提的问题修完后，是否又引入了新的合同缺口

对照依据：

- 当前 spec：`docs/dev/specs/codex-native-plugin-install-rpc.md`
- 当前仓库实现：`packages/cli/src/**`
- 当前仓库文档：`docs/architecture.md`、`docs/plugin-installation.md`、`docs/testing.md`
- 本机 Codex 源码：`/Users/LeslieChan/Desktop/codex/codex-rs/**`

## Findings

本轮没有发现新的阻塞性问题，也没有再看到上一轮指出的主流程合同缺口。

上一轮最关键的缺口，是 native recovery breadcrumb 的独立持久化路径没有和 `ensureLocalMarketplace()` / `aw init --force` 的目录刷新合同绑定，repair install 有机会在第 1 步先把恢复证据擦掉。这个问题这次已经被补齐，而且补得比较完整：

- 决策层已经明确 breadcrumb 既要独立于 `installed.json`，也要独立于本地 marketplace refresh：`docs/dev/specs/codex-native-plugin-install-rpc.md:45-46`
- breadcrumb 合同里已经把 refresh / `replaceDirectoryAtomically()` / 布局校验一起纳入：`docs/dev/specs/codex-native-plugin-install-rpc.md:128-129`
- breadcrumb-only repair install 也明确要求 refresh 后仍能读到同一个 breadcrumb：`docs/dev/specs/codex-native-plugin-install-rpc.md:142-151`
- 实现建议和测试要求也同步把这层合同写实了：`docs/dev/specs/codex-native-plugin-install-rpc.md:374-376`、`418-419`、`452-453`

换句话说，旧报告里那条中优先级 finding 可以关闭。

## 可落地性评估

这份 spec 在当前基线下是能落地的，没有出现“需求想做，但现有架构接不住”的阻塞。

- Codex 侧能力是存在的。本机 app-server 已经暴露 `plugin/install` 和 `plugin/uninstall`，AW 不需要修改 Codex 源码就能走官方 install/uninstall 路径：`/Users/LeslieChan/Desktop/codex/codex-rs/app-server/src/codex_message_processor/plugins.rs:501-579`、`771-801`
- Codex 官方安装语义和 spec 现在的口径一致，确实是“先 materialize cache，再写用户级 enabled”：`/Users/LeslieChan/Desktop/codex/codex-rs/core-plugins/src/manager.rs:843-863`
- app-server 初始化顺序、JSONL transport，以及当前省略 `"jsonrpc": "2.0"` 的协议形态，也和 spec 一致：`/Users/LeslieChan/Desktop/codex/codex-rs/app-server/README.md:95-140`、`214-215`

从 AW 当前实现看，改动面虽然不小，但都落在现有清晰的接缝上：

- `packages/cli/src/adapters/codex.ts` 里 user scope native install / uninstall 还是旧的 marketplace add + config enabled 路径，正好是接 app-server client 的位置
- `packages/cli/src/commands/install.ts` 和 `packages/cli/src/commands/uninstall.ts` 已经有 native write 后失败、ledger 回滚、historical uninstall 保护这些事务边界，只是当前语义还偏“全局 degraded”，需要按 spec 收敛到插件级 breadcrumb
- `packages/cli/src/commands/discovery.ts`、`packages/cli/src/commands/status.ts` 现在主要围绕 config enabled 做 Codex native evidence 推断，spec 这次把 cache installed / breadcrumb / disabled-only 语义拆清楚后，扩展点也明确了
- `packages/cli/src/utils/local-marketplace.ts` 当前已经有 `installed.json`、`plugin-config/`、`plugin-install-snapshots/` 的 preserve/restore 机制，breadcrumb 作为同类 runtime state 接进去是自然演进，不是推翻重做

所以这轮的判断还是：实现工作量大，但方向正确，而且和当前代码组织是对齐的。

## 上轮问题复核

上一轮报告里提到的几类关键问题，这次都已经补上，没有看到残留的不一致：

- breadcrumb 必须先于 post-check / lifecycle / ledger 落盘，而且允许 `pending_after_native_write` 中间态：`docs/dev/specs/codex-native-plugin-install-rpc.md:117-129`
- breadcrumb 写入失败时，不再假装 AW 一定具备后续 repair / uninstall 自动授权：`docs/dev/specs/codex-native-plugin-install-rpc.md:113-115`、`240-248`
- `ready` 判定已经从“enabled 即 installed”收紧成必须同时满足 installed + enabled + 成功 scope record：`docs/dev/specs/codex-native-plugin-install-rpc.md:277-300`
- breadcrumb-only uninstall 不再允许借 current catalog 或 lifecycle fallback 去跑 uninstall script：`docs/dev/specs/codex-native-plugin-install-rpc.md:192-197`
- breadcrumb-only repair install / reject explicit upgrade / skip `upgrade --all` 这三条恢复分支已经闭环：`docs/dev/specs/codex-native-plugin-install-rpc.md:140-161`、`251-257`
- disabled-only config entry 的证据口径已经统一，不再同时被说成“阻塞 cleanup”和“不是 native evidence”：`docs/dev/specs/codex-native-plugin-install-rpc.md:39`、`175-186`、`306-312`、`431-433`

## 剩余风险

本轮没有新的 spec 缺陷，但仍有两个实现层面的剩余风险，建议在开发时继续盯紧：

- `plugin/install` / `plugin/uninstall` 仍是 Codex app-server README 里标注为 under development 的接口。这不是当前 spec 的逻辑漏洞，但属于外部协议风险。spec 已经要求把 transport 封装进独立 client，并在失败时 hard fail，不做 config-only fallback，这个处理方向是对的。
- 这次是一次明确的 `aw status --json` breaking change。spec 已经写明不提供旧语义过渡期，但实现时要把 JSON schema、测试、文档和调用方说明一起更新，否则更容易在交付阶段出兼容性争议。

## 结论

这份 spec 现在已经比较完整，主流程、失败语义、恢复路径和状态判定都闭环了。上一轮报告指出的问题已经修掉，我这轮没有再发现新的逻辑漏洞，也没有看到当前仓库基线承接不了的需求点。

结论上，这份 spec 可以进入实现阶段。后续更值得投入精力的，不是再补主流程需求，而是按 spec 把 app-server client、breadcrumb 存储、status/discovery 语义和测试矩阵一次性接稳。
