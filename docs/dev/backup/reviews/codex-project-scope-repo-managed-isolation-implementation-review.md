# `codex-project-scope-repo-managed-isolation` 实现代码复审报告

审查对象：

- 计划文档：`docs/dev/plans/codex-project-scope-repo-managed-isolation.md`
- 实现代码：`packages/cli/src/**`
- 测试：`packages/cli/tests/**`

审查时间：2026-04-30（复核更新）

本次复核背景：

- 上一版报告里提到的两处可维护性简化点已经处理
- 这轮重点确认抽象是否真正收口到共享模块、实现是否继续严格贴合计划文档，以及测试矩阵是否已经补齐到 build / pack 产物层

## Findings

本轮复核未发现新的 blocking、major 或 medium finding。

上一轮计划复审里唯一还没完全收口的点，是 `upgrade --all` 的稳定 `skipped[].code` 合同。这次已经真正落到实现和回归测试里了：

- target-level skip code 的分流已经集中落在 `packages/cli/src/commands/upgrade.ts:666-825`
- 10 个稳定 code 的正向回归已经补齐，见 `packages/cli/tests/integration/upgrade-command.test.ts:724-913`
- CLI receipt / entry 层也有对应断言，见 `packages/cli/tests/unit/cli-entry.test.ts:269-352`

## 代码实现质量

这轮实现的代码质量是好的，关键不是“功能做出来了”，而是边界收得比较稳。

- Codex capability 已经真正改成 scope-aware，而不是继续拿平台级 native 能力硬套 project scope。核心入口很清楚：`packages/cli/src/adapters/codex.ts:359-401`。
- “只读 catalog” 和 “可写 runtime 准备” 被明确拆开了，Codex project-only 路径不会再顺手去修 `~/.aw`。这部分收口在 `packages/cli/src/commands/common.ts:520-617`，install/upgrade 入口也都先走 `readOnly` 再决定是否升级到 `runtimeWritable`，见 `packages/cli/src/commands/install.ts:1100-1173`。
- Codex project 的写入前安全预检被单独抽成了模块，external ownership、tracking identity、project config 可读性、repo artifact 冲突和 catalog 缺失都在同一层判断，顺序也符合计划，见 `packages/cli/src/commands/codex-project-safety.ts:96-200` 和 `397-477`。
- 公共 `slashCommands` 的 Codex manual-only 合同也落得比较干净：source contract 在 `packages/cli/src/utils/slash-commands.ts:401-669`，bundle 物化在 `packages/cli/src/generators/local-plugin.ts:856-883`，没有再残留 Claude-only 语法或让 Codex 侧偷偷变成 implicit skill。

## 计划对齐情况

按“是否严格按计划实现”来判断，我这次的结论是：可以给“是”。

- Codex project scope 不再写 user-native plugin / marketplace 状态，`requiresCodexNativePlugin()` 在 project scope 固定为 `false`，安装证据改成 repo-managed kinds，见 `packages/cli/src/adapters/codex.ts:359-401`。
- apps 在 Codex project scope 仍然是硬拒绝，不做 mixed partial install；skills-only、mcp-only、slashCommands-only 都能作为 project 候选，这一层实现和测试是一致的，见 `packages/cli/src/commands/codex-project-installability.ts:13-89` 与 `packages/cli/tests/unit/codex-project-installability.test.ts:213-227`、`241-245`、`647-726`。
- 计划要求的“安全预检先于 required config prompt / 写入”已经按执行顺序落地，见 `packages/cli/src/commands/install.ts:1124-1159` 和 `packages/cli/tests/unit/codex-project-safety.test.ts:825-944`。
- `upgrade --all` 的 evidence-first 推断、stable skip code、部分 skipped 仍返回成功退出的合同也都落下来了，主实现见 `packages/cli/src/commands/upgrade.ts:503-599`、`666-835`，关键回归在 `packages/cli/tests/integration/upgrade-command.test.ts:724-913`。
- Codex project 在没有本机 `codex` executable 时依然可执行 repo-managed install / uninstall / upgrade，这条主合同已经打通到普通命令、`upgrade --all` 和 interactive 候选，见 `packages/cli/src/commands/common.ts:943-1159`、`packages/cli/src/commands/upgrade.ts:503-599`、`packages/cli/src/commands/interactive.ts:170-208`、`780-909`。

## 测试覆盖评估

就这份计划的实现范围来说，自动化覆盖已经比较完整，我没有再看到明显缺口。

我这次实际跑了：

- `pnpm test:unit`：37 个 test files，346 个测试，全部通过
- `pnpm test:integration`：12 个 test files，170 个测试，全部通过
- `pnpm test:smoke:build`：1 个 test file，5 个测试，全部通过
- `pnpm test:smoke:pack`：1 个 test file，2 个测试，全部通过

从覆盖面看，关键风险都已经被锁住了：

- Codex project installability、read-only catalog、平台 gate、interactive 可见性：`packages/cli/tests/unit/codex-project-installability.test.ts`、`packages/cli/tests/unit/codex-project-platform-gates.test.ts`、`packages/cli/tests/unit/codex-project-read-only-catalog.test.ts`
- 写入前安全预检、project status、quoted MCP key、slashCommands manual-only、rollback：`packages/cli/tests/unit/codex-project-safety.test.ts:722-1260`
- `upgrade --all` 的 10 个 stable skip code 和 auto 推断：`packages/cli/tests/integration/upgrade-command.test.ts:724-913`
- capabilityChanged 显式升级恢复链、skill trigger 偏好恢复：`packages/cli/tests/integration/skill-trigger-command.test.ts`
- build / pack 产物层面的 public `slashCommands`、MCP、scripts 打包：`packages/cli/tests/smoke/build-smoke.test.ts`、`packages/cli/tests/smoke/pack-smoke.test.ts`

补充说明：

- `pnpm test:smoke:pack` 过程中出现了 sourcemap 指向未随 tarball 一起分发源码路径的 warning，但测试本身通过，也不影响这次 repo-managed isolation 计划范围内的功能判断。
- 如果后续想继续收紧发包产物整洁度，可以把 sourcemap warning 作为单独的非阻塞跟进项处理；它不构成这轮实现复审的 finding。

## 可简化点处理结果

本轮已把两处后续可维护性优化收口：

1. 平台解析里的 Codex project native fallback 和 evidence-first auto 推断已经收进 `packages/cli/src/commands/platform-resolution.ts`。`install` / 普通 `upgrade` / interactive / `upgrade --all` 继续保留各自的业务文案，但共享“native 可用或 Codex project repo-managed 可执行”“unknown 先拒绝、单侧证据才推断”的基础规则。
2. Codex repo-managed surface 的声明解析已经收进 `packages/cli/src/utils/codex-project-surface.ts`。adapter、safety preflight、installability 和 upgrade 都复用同一套 managed kind / capability snapshot / skill 与 MCP 声明解析，后续扩展 repo-managed kind 时不需要在多处同步近似逻辑。

## 结论

这轮实现可以继续通过复审。

- 实现代码质量：良好，边界清楚，关键合同都落到了独立模块
- 是否严格按计划实现：是
- 测试覆盖是否完整：按计划范围看，已经闭环；我这次实跑的 unit / integration / smoke:build / smoke:pack 都通过
- 是否存在可以明显简化的地方：原报告里的两处可维护性简化点已经处理
