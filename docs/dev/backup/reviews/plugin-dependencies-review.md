# `plugin-dependencies.md` 需求复审报告

审查对象：`docs/dev/specs/plugin-dependencies.md`  
审查时间：2026-05-06

这轮复审重点看五件事：

- 需求本身是否合理正确
- 关键流程是否还有逻辑漏洞
- 有没有更稳的实现收口方式
- 在当前仓库基线下能不能落地
- 上一轮报告里的问题是否已经修掉

对照依据：

- 当前 spec：`docs/dev/specs/plugin-dependencies.md`
- 当前仓库实现：`packages/cli/src/**`
- 当前仓库文档：`docs/architecture.md`、`docs/plugin-authoring.md`、`docs/plugin-installation.md`

## Findings

本轮没有发现新的阻塞问题。

上一轮报告指出的问题，已经确认修复：

- 显式 `target.scope: "project"` 现在已经收紧为硬约束，不再允许用 user scope fallback 伪装成“依赖已满足”。这一点同时写进了总决策、scope 语义、planner 约束和示例，语义是一致的，见 `docs/dev/specs/plugin-dependencies.md:37-38`、`53`、`152-170`、`532-555`。
- `upgrade --all` 现在明确区分“显式保留根集合”和“current catalog 目标依赖前置图”，旧 edge 但已不在目标图里的自动依赖，不再反向阻塞父插件升级，见 `docs/dev/specs/plugin-dependencies.md:268-281`。
- `status` 现在也把“当前安装健康”和“current catalog drift”拆成两层真值，catalog 变化不会再被直接误报成当前安装损坏，见 `docs/dev/specs/plugin-dependencies.md:353-369`。

如果只回答“旧 report 里的问题修没修”，结论是：已经修完，这轮没有看到回退。

## 需求合理性与正确性

这版 spec 的主体设计已经成立，需求方向和边界都比较清楚。

- 依赖合同仍然只留在 AW 自己的 source/runtime manifest 中，没有把 AW 依赖语义塞进 Claude/Codex 平台原生 manifest，边界是对的，见 `docs/dev/specs/plugin-dependencies.md:17-19`、`128-138`。
- 依赖平台语义拆成“生效条件”和“安装目标”两层，`when.platforms` 只控制当前安装平台下是否生效，不改变实际安装平台，这个模型能正确覆盖 Codex-only / Claude-only 组合依赖，见 `docs/dev/specs/plugin-dependencies.md:33-35`、`132-150`、`557-595`。
- scope 规则现在也足够严谨：省略 `target.scope` 才允许 project -> user fallback；显式 `user` / `project` 都是硬约束，不会再把“作者要求安装到项目里”的依赖降级成“用户级装过就算满足”，见 `docs/dev/specs/plugin-dependencies.md:36-38`、`152-172`。
- `planner` 收口方向是对的。install、upgrade、uninstall、status 都要共享同一套 location-aware 选址和 edge 投影规则，否则一定会在 fallback、protect、auto cleanup 和 status 诊断上分叉，见 `docs/dev/specs/plugin-dependencies.md:174-191`。
- ledger 以 canonical outgoing dependency edges 为真值，而不是同时持久化 `dependents` / `ref-count` / `autoRemovable` 这类派生值，这个收口也正确，能明显降低写路径和恢复路径的自相矛盾风险，见 `docs/dev/specs/plugin-dependencies.md:308-347`。
- 图级事务和 fail-closed 回滚语义已经补齐。尤其是“自动依赖已写出、父插件后续失败”和“native/artifact/tracking 部分写出但无法完全回滚”这两条最危险的路径，现在都有明确收口，不再是实现者自己猜，见 `docs/dev/specs/plugin-dependencies.md:217-229`。

从逻辑完整性看，这版 spec 没再看到明显的自相矛盾或关键漏口。

## 更优实现方式

如果问“有没有比当前 spec 更稳的实现方向”，我的结论是：没有必要再换模型，当前 spec 里要求的统一 planner 本身就是更优解。

不建议退回下面这些实现方式：

- 不建议在 `install`、`upgrade`、`uninstall`、`status` 四条命令里各自补依赖判断分支。这样最容易把 `target.scope` 硬约束、旧 edge 保护和 auto cleanup 条件做散。
- 不建议把 `dependents`、`ref-count`、`autoRemovable` 再持久化成第二套真值。当前 spec 要求它们统一从 outgoing edges 反推，这比维护双向状态稳得多。
- 不建议把 current catalog 直接当成 status 的唯一依赖真值。当前 spec 改成“installed snapshot health + catalog drift”两层判断，是更符合 AW 现有快照架构的做法。

真正值得坚持的实现方向只有一个：把 location graph 规划做成独立收口层，再让 install / upgrade / uninstall / status 消费同一个 planning 结果。

## 可落地性评估

这份 spec 在当前仓库基线下可以落地，但它是一次中到大型结构改造，不是 manifest schema 小修。

当前基线和目标能力之间的差距仍然客观存在：

- manifest 类型和白名单校验还不认识 `dependencies`，见 `packages/cli/src/types.ts:320-336`、`packages/cli/src/utils/manifest.ts:1645-1671`。
- ledger 结构目前只有 platform/scope record、capability snapshot、install options、lifecycle snapshot 和 Codex shared native refs，还没有 explicit / auto-installed / outgoing dependency edges，见 `packages/cli/src/types.ts:893-934`、`packages/cli/src/utils/local-marketplace.ts:136-220`。
- install 仍然是“platform x target”线性推进，preflight 和写入顺序还没有 location-level 依赖图概念，见 `packages/cli/src/commands/install.ts:739-825`。
- `upgrade --all` 现在的候选集仍然主要从 managed evidence、tracking 和 breadcrumb 证据反推，尚未引入“显式保留根 vs 目标依赖图”这层规划，见 `packages/cli/src/commands/upgrade.ts:433-529`。
- uninstall 目前也还是按用户传入的单个位置取 scope record，不理解 incoming dependents、自动清理和同命令联合卸载，见 `packages/cli/src/commands/uninstall.ts:304-333`。

但另一方面，当前基线已经有足够清晰的接缝支撑这次改造：

- install snapshot 和 `healthSource` 已经是现成机制，status 也已经能优先从快照恢复 manifest 真值，再回退到 current catalog / historical，这和 spec 里的“installed health vs catalog drift”模型是相容的，见 `packages/cli/src/commands/status.ts:213-258`、`packages/cli/src/utils/plugin-scripts.ts:250-304`。
- 架构文档已经明确 source manifest 只存在于 AW contract、build 后 staging manifest 是 runtime 真值、成功安装会持有 scope-owned 快照，这些都能直接复用，见 `docs/architecture.md:84-96`。
- Codex / Claude 的 scope 语义和 Codex project installability 约束也已经是当前系统的既有规则，依赖能力是在现有位置模型上扩展，不是另起一套状态空间，见 `docs/plugin-authoring.md:219-225`。

所以落地判断是：

- 能做。
- 但必须按“planner + ledger schema + 写路径 + 读路径 + 作者工具/文档同步”这一整套来做。
- 不适合拆成只改 install、不改 status / uninstall / authoring tool 的半套实现。

## 残余风险与测试重点

这轮不是 spec 逻辑问题，而是实现阶段一定要重点补测试的地方：

- project 父插件省略 `target.scope` 时复用 user 依赖；显式 `target.scope: "project"` 时绝不 fallback。
- `upgrade --all` 面对旧 edge、当前 catalog 新依赖、已删除依赖和 auto-installed orphan 时的根集合、skipped 传播和自动清理候选。
- 同一命令多父插件共享同一缺失依赖时的拓扑顺序、去重安装和 install options 冲突。
- 事务失败收口：自动依赖已安装但父插件失败、edge 未提交、部分 native/tracking/ledger 已写出的 degraded / cleanup-blocked 路径。
- `status` 对 installed snapshot 自洽但 current catalog 已变化的旧安装，必须只报 drift，不直接误判 missing dependency。
- 作者工具、CLI source manifest 校验和 build 后 staging manifest 复校必须保持同一语义，不能出现“作者工具通过、CLI 拒绝”或“源码合法、build 改写后非法”的分叉。

## 结论

这版 spec 已经达到可进入实现设计的状态。

- 上一轮报告里的问题已经修复。
- 这轮没有发现新的阻塞项。
- 需求本身合理，关键语义闭合，和当前基线的架构方向一致。
- 最稳的落地方式仍然是按 spec 要求补一层统一 location planner，再同步改 ledger、写路径、status/uninstall 读路径，以及作者工具和文档。
