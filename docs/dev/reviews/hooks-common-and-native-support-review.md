# `hooks-common-and-native-support.md` 计划审查报告

审查对象：`docs/dev/plans/hooks-common-and-native-support.md`  
审查时间：2026-04-27

本轮复审基于当前仓库基线，范围限定为：

- 计划审查，不是代码实现复审
- 不考虑旧版构建物兼容或迁移成本
- 重点看计划是否能在当前基线上落地
- 重点检查测试覆盖是否足以兜住这轮改动

对照依据：

- 当前仓库实现：`packages/cli/src/**`
- 当前测试：`packages/cli/tests/**`
- Codex 源码：`/Users/LeslieChan/Desktop/codex/codex-rs`
- Claude Code 源码：`/Users/LeslieChan/Desktop/claude-code-source-code/src`

## Findings

本轮未发现需要继续修改的阻断问题。

上一轮遗留的 Codex shared `hooks.json` 多 handler matcher group 所有权边界问题，这次已经在计划里补实，不再构成 finding。关键收口现在已经明确写进这些位置：

- `docs/dev/plans/hooks-common-and-native-support.md:57`
- `docs/dev/plans/hooks-common-and-native-support.md:225-231`
- `docs/dev/plans/hooks-common-and-native-support.md:252-257`
- `docs/dev/plans/hooks-common-and-native-support.md:323-339`
- `docs/dev/plans/hooks-common-and-native-support.md:446-447`
- `docs/dev/plans/hooks-common-and-native-support.md:475-479`
- `docs/dev/plans/hooks-common-and-native-support.md:508-510`

这些段落已经把最关键的实现边界写清楚了：

- AW 只认领“整组精确等于自己生成形状”的 raw matcher group
- multi-handler group 和 mixed handler group 一律按 opaque foreign raw group 保留
- install / upgrade / uninstall / status / historical rebuild 都不能再按 handler 粒度拆组、扣减或误判满足

## Open Questions / Assumptions

- 本轮仍按“开发阶段、不考虑旧版构建物兼容”处理，不要求兼容旧 `session_stop`、旧 tracking hook shape 或旧 rendered artifact。
- Claude / Codex 的 hook 事实基线我重新核对过，计划里的事件集合、matcher 能力和 Codex handler shape 与当前上游一致，没有看到新的事实性偏差：
  - Claude `HOOK_EVENTS`：`/Users/LeslieChan/Desktop/claude-code-source-code/src/entrypoints/sdk/coreSchemas.ts:355-383`
  - Claude matcher metadata：`/Users/LeslieChan/Desktop/claude-code-source-code/src/utils/hooks/hooksConfigManager.ts:28-264`
  - Claude runtime `matchQuery`：`/Users/LeslieChan/Desktop/claude-code-source-code/src/utils/hooks.ts:1613-1685`
  - Codex hooks schema：`/Users/LeslieChan/Desktop/codex/codex-rs/config/src/hook_config.rs:8-109`
  - Codex matcher 语义：`/Users/LeslieChan/Desktop/codex/codex-rs/hooks/src/events/common.rs:98-154`
  - Codex discovery 对 `async` / `prompt` / `agent` 的处理：`/Users/LeslieChan/Desktop/codex/codex-rs/hooks/src/engine/discovery.rs:328-372`
  - Codex 多 command handler group 的上游测试事实：`/Users/LeslieChan/Desktop/codex/codex-rs/core/tests/suite/hooks.rs:103-141`
- 从当前基线看，这份计划已经把会被这轮改动打到的主链路都点到了：`manifest`、`generator`、`rendered contract`、`tracking`、`generated artifacts`、Codex adapter、Claude capability snapshot、historical fallback、作者工具和文档，没有再看到明显缺口。

## 测试评估

这版测试矩阵已经覆盖了本轮最重要的落地风险，覆盖面比上一轮完整很多。

- source manifest、bundle source manifest、embedded catalog 的 round-trip 已经有明确锚点：`docs/dev/plans/hooks-common-and-native-support.md:405-425`
- 公共 hooks / native hooks 的生成、rendered contract、canonical identity、tracking 去重已经分别落到单测：`docs/dev/plans/hooks-common-and-native-support.md:426-457`
- Codex shared `.codex/hooks.json` 最容易出事故的路径，已经覆盖 install / upgrade / uninstall / status / historical rebuild，而且把 foreign raw groups、历史 AW raw groups、matcherless event、`timeout` / `statusMessage` / `prompt` / `agent` / `async`、multi-handler group、mixed group 都写进去了：`docs/dev/plans/hooks-common-and-native-support.md:458-480`、`516-520`
- Claude hooks 能力的 current catalog、ledger snapshot、current catalog missing fallback 也有独立回归，不再只靠公共 hooks 旧路径顺带覆盖：`docs/dev/plans/hooks-common-and-native-support.md:481-491`、`499-511`

上一轮缺的那块 multi-handler / mixed foreign group 测试，这次也已经补到了 unit + integration 两层：

- shared read/write mode 分类与 canonical identity：`docs/dev/plans/hooks-common-and-native-support.md:443-447`
- Codex adapter 的保留、扣减、status 行为：`docs/dev/plans/hooks-common-and-native-support.md:472-479`
- CLI 命令级共享文件回归：`docs/dev/plans/hooks-common-and-native-support.md:507-510`

以当前计划的测试设计来看，我没有再看到明显漏掉的高风险测试面。

## 结论

在当前基线和本轮约束下，这份计划已经具备进入实现的条件。

公共 hooks 与 `nativeHooks` 的边界、historical fallback 的信息来源、Codex shared `hooks.json` 的所有权模型，以及测试矩阵都已经写实。只要实现时严格按计划里的 canonical identity 和“三类 raw group 分流”落地，这轮改造不再卡在设计层面。
