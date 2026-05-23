# `plugin-state-simplification.md` 审查报告

审查对象：`docs/dev/specs/plugin-state-simplification.md`  
审查时间：2026-05-22  
对照基线：`packages/cli/src/install-state/{status-projection,shared-runtime-owner}.ts`、`packages/cli/src/commands/{cleanup,reinstall,status,console-model}.ts`、`packages/cli/src/index.ts`、`docs/architecture.md`、`docs/plugin-installation.md`  
交叉核对：`docs/dev/specs/plugin-state-and-tui-simplification.md`

## 结论

本轮未发现新的 blocking 或 significant 问题。上轮报告里的两条核心缺口，这次都已经在 spec 里补齐了：

- 无 record 场景的四态落位优先级已经写清，`claimableProjectArtifacts` 也明确落到 `external`，见 `docs/dev/specs/plugin-state-simplification.md:109-116`、`280`。
- shared runtime ownership / takeover 的公开合同已经补全，明确移除 `--takeover-shared-runtime`，并把 owner 冲突收敛为 command-level blocker / diagnostic / `nextSteps`，见 `docs/dev/specs/plugin-state-simplification.md:250-265`、`284-285`。

按当前文本，这份 spec 已经自洽，也能在当前基线上落地。现在的主要风险不在 spec 本身，而在实现时要把旧状态模型、旧命令入口和旧文档一次清干净，避免新旧合同并存。

## Findings

本轮没有发现需要继续修改这份 spec 的 blocking 或 significant 问题。

## 自洽性检查

- 四态定义、无 record 优先级、`reasons` / `diagnostics` / `nextSteps` 的分工现在是闭合的。`external` 明确同时覆盖“外部归属不明”和“可验证但只能显式认领的 project shared artifacts”，不再像上一版那样在 adopt 场景上留空，见 `docs/dev/specs/plugin-state-simplification.md:107-122`。
- 命令边界彼此一致。普通 `install` 只在 `external` 上 fail closed；`cleanup` 不会默认删除可认领共享产物；`reinstall` 允许直接收口 `cleanupRequired`，但会在 `external`、project adopt、verified dependents 和无法安全删除时停止；`uninstall` 的安全阻断继续留在命令层，而不是重新膨胀成状态分支，见 `docs/dev/specs/plugin-state-simplification.md:136-178`、`206-265`。
- `repair` 移除后的职责分流也是闭合的。project fresh clone 认领改到 `aw install --adopt-existing`，dependency index 维护改到 `aw cleanup --dependency-index --prune-stale <token> --yes`，shared runtime takeover 不再公开，配置驱动 drift 则由自动 apply、TUI 重新应用配置或 `reinstall` 承接，见 `docs/dev/specs/plugin-state-simplification.md:180-190`、`214-265`。
- 我交叉看了 `docs/dev/specs/plugin-state-and-tui-simplification.md` 的对应段落，和这份来源 spec 在四态、adopt、cleanup、reinstall、移除 `repair`、移除 `--takeover-shared-runtime` 这些关键点上是一致的，没有发现两份规格互相打架的地方。

## 当前基线可落地性

- 这次改动面不小，但主干改造点是收敛的，不需要推翻现有架构。状态投影集中在 `packages/cli/src/install-state/status-projection.ts:447-543`；cleanup / uninstall / reinstall 的安装态读写已经统一走 `packages/cli/src/commands/install-state-removal.ts:742-1407`，并分别被 `packages/cli/src/commands/cleanup.ts`、`packages/cli/src/commands/reinstall.ts` 复用。
- shared runtime 的 preflight 和 owner 语义也已经集中在 `packages/cli/src/install-state/shared-runtime-owner.ts:438-609`。spec 现在补上的 claim / refresh / release / no-takeover 规则，能够直接映射到这一层，不需要额外再发明一套旁路机制。
- CLI 命令注册面集中在 `packages/cli/src/index.ts:920-1237`，状态文案、`nextSteps` 和控制台动作集中在 `packages/cli/src/commands/status.ts:3112-3177`、`packages/cli/src/commands/console-model.ts:1042-1357`。从当前代码组织来看，四态收敛、移除 `repair`、移除 `cleanup --plan`、替换 adopt 入口、去掉 `--takeover-shared-runtime`，都属于“改动面广但边界清楚”的工作，不是“现有结构承接不了”的工作。
- 真正的落地成本在旧合同清理，而不是新机制缺位。当前基线里，`repair`、`--takeover-shared-runtime`、`cleanup --plan` 和旧状态词还同时存在于 CLI 入口、status / console 投影、公开文档、架构文档、作者工具和测试里，例如 `packages/cli/src/index.ts:928-1237`、`docs/plugin-installation.md:101-175`、`docs/architecture.md:96,178`、`packages/cli/tests/` 下大量断言。只要按 spec 把这些面同步改掉，当前基线没有明显的架构性阻塞。

## 建议

这份 spec 可以进入实现阶段。

实现时建议把下面几类改动视为同一批公开合同变更，一次完成，而不是拆成多轮半迁移：

- `install-state` / `status` / `console-model` / `cleanup` / `reinstall` / `index.ts`
- `docs/plugin-installation.md`、`docs/architecture.md`
- `.agents/skills/create-agent-workflows-plugin/`
- 依赖旧状态词、旧命令和旧 flag 的单元测试 / 集成测试 / 文档测试

这样可以避免底层四态已经切换完成，但 CLI help、状态页、TUI、文档或测试还在继续暴露 `repair`、`cleanup --plan`、`--takeover-shared-runtime`、`needsRepair` / `adoptable` / `residual` / `externallyManaged` 的半成品状态。
