# Codex 原生插件安装/卸载 RPC 接入执行计划评审报告

审查对象：`docs/dev/plans/codex-native-plugin-install-rpc-plan.md`  
对照规格：`docs/dev/specs/codex-native-plugin-install-rpc.md`  
审查时间：2026-05-04

## 结论

这轮复审未发现新的问题。

上轮 review 提到的两个核心缺口已经补齐：

- breadcrumb 与 lifecycle snapshot 的时序约束，已经被拆成明确的 `prepare / persist` 两段式改造，并把真实 snapshot 落盘推迟到 `pending_after_native_write` breadcrumb 成功之后：`docs/dev/plans/codex-native-plugin-install-rpc-plan.md:258-267`
- 默认输出、`--verbose`、debug log 和对应测试合同，已经从“文案要求”补成了带 event 类型、关键 payload 和断言边界的实施项：`docs/dev/plans/codex-native-plugin-install-rpc-plan.md:168-185`、`321-379`

按当前版本看，这份计划和 spec 已经对齐，没有再看到明显的偏差、遗漏或新增需求；计划内部也基本自洽，能在当前仓库基线上落地。就“计划是否把单元测试覆盖面设计完整”这个问题来说，我的结论也改成肯定：阶段 6 的单测矩阵已经覆盖了这次改造的关键行为面。

## Findings

本轮未发现需要修改的问题。

## Spec 对齐情况

计划已经覆盖 spec 里的关键合同，而且没有看出超出 spec 的额外功能扩张：

- Codex user scope 原生安装改为 `codex app-server` `plugin/install`，不再走 config-only 假成功：`docs/dev/plans/codex-native-plugin-install-rpc-plan.md:35-68`、`233-254`，对应 spec：`docs/dev/specs/codex-native-plugin-install-rpc.md:73-115`
- Codex user scope 原生卸载只在最后一个 shared native ref 移除后调用 `plugin/uninstall`，并用 config entry + active cache 做 post-check：`docs/dev/plans/codex-native-plugin-install-rpc-plan.md:237-252`、`349-355`，对应 spec：`docs/dev/specs/codex-native-plugin-install-rpc.md:163-190`
- native recovery breadcrumb 独立于 `installed.json`，并且要跨 `ensureLocalMarketplace()` / `aw init --force` 保留：`docs/dev/plans/codex-native-plugin-install-rpc-plan.md:86-139`、`218-229`，对应 spec：`docs/dev/specs/codex-native-plugin-install-rpc.md:117-138`
- breadcrumb-only repair install、breadcrumb-only uninstall、breadcrumb-only upgrade 拒绝，以及 `upgrade --all` skipped 语义都已进入计划：`docs/dev/plans/codex-native-plugin-install-rpc-plan.md:268-282`、`346-348`、`368-372`，对应 spec：`docs/dev/specs/codex-native-plugin-install-rpc.md:140-197`、`251-257`
- status/discovery breaking change、disabled-only contract、marketplace cleanup evidence 模型也都写进去了：`docs/dev/plans/codex-native-plugin-install-rpc-plan.md:288-315`、`355-359`，对应 spec：`docs/dev/specs/codex-native-plugin-install-rpc.md:261-313`
- Codex project scope 继续保持 repo-managed 隔离，没有混入 user native install/uninstall：`docs/dev/plans/codex-native-plugin-install-rpc-plan.md:25-31`、`235-236`、`356-358`，对应 spec：`docs/dev/specs/codex-native-plugin-install-rpc.md:199-214`

## 可落地性判断

按当前基线看，这份计划是能落地的，主要接缝也都找对了：

- `CodexAdapter.installPlugin()` / `uninstallPlugin()` 现在正停在“marketplace add + enabled config / remove enabled + remove marketplace”这条旧路径上，切换到 app-server RPC 的落点很清楚：`packages/cli/src/adapters/codex.ts:1429-1517`
- install 事务里现在确实是 native write 前就先创建 lifecycle snapshot，计划正面修了这个时序问题，而不是绕过去：`packages/cli/src/commands/install.ts:597-607`、`721-818`，`packages/cli/src/utils/plugin-scripts.ts:221-252`
- `local-marketplace` 现有流程本来就在 preserve `plugin-config/` 和 `plugin-install-snapshots/`，把 `native-recovery/` 纳入同类 runtime state 是顺着现有结构扩展，不需要重写刷新链路：`packages/cli/src/utils/local-marketplace.ts:358-580`
- status / discovery 当前仍围绕旧的 native fallback 语义运转，所以计划把 helper、状态机和 JSON schema 一起改，是必要且可实施的：`packages/cli/src/commands/status.ts:403-503`、`packages/cli/src/commands/discovery.ts:73-80`

我没有看到“计划要求的行为和当前代码结构不相容，实施时必然卡住”的点。

## 测试覆盖判断

如果问题是“这份执行计划有没有把该补的单元测试写进计划里”，当前答案可以给到“有”。

阶段 6 现在已经把下面这些关键改动面都锁进单测清单了：

- app-server client 的协议顺序、错误映射、提前退出、非 JSON 行、spawn failure：`docs/dev/plans/codex-native-plugin-install-rpc-plan.md:323-325`
- status breaking change 和完整状态矩阵，包括 `ready` / `needsAttention` 边界、disabled-only 合同、`native.recovery.*` 稳定字段：`docs/dev/plans/codex-native-plugin-install-rpc-plan.md:330-337`
- breadcrumb 的 pending 态、失败态、独立读取、跨 marketplace refresh 保留，以及“写入失败时不能承诺自动授权”的分支：`docs/dev/plans/codex-native-plugin-install-rpc-plan.md:339-344`
- snapshot 时序、repair install、breadcrumb-only uninstall、breadcrumb-only upgrade / `upgrade --all` skipped：`docs/dev/plans/codex-native-plugin-install-rpc-plan.md:341-348`
- user native uninstall 的正向分支、shared native refs 保护分支、disabled entry post-check、marketplace cleanup evidence 模型：`docs/dev/plans/codex-native-plugin-install-rpc-plan.md:349-355`
- project scope 隔离、纯 native-only 拒绝、`apps` fail fast，以及 command event / debug log：`docs/dev/plans/codex-native-plugin-install-rpc-plan.md:356-359`

也就是说，从计划设计层面看，单测覆盖已经闭环了。剩下的不是“计划里漏了哪些测试”，而是实现时要按这份矩阵真正写出来并跑完：

```bash
pnpm test:unit
pnpm test:integration
pnpm test:smoke:build
```

这里需要区分一下：我这次确认的是“计划里的测试范围已经完整”，不是“代码实现已经通过这些测试”。
