# `aw-tui-ux-optimization-plan.md` 实现代码审查报告

审查日期：2026-05-13  
审查对象：`docs/dev/plans/aw-tui-ux-optimization-plan.md` 对应实现（`08a7d04..HEAD`）  
审查范围：实现代码质量、是否按计划落地、测试覆盖与执行情况

## 结论

这轮实现整体完成度很高，阶段 1-9 的主体改动、公开文档同步和大部分测试骨架都已经落地，`consoleItemsSchemaVersion: 2`、`cleanup --plan`、`--remove-config`、scope 互斥预检、首页/详情/诊断模型拆分这些核心方向都能在代码里找到对应实现。

但本次 review 发现 3 个仍然影响计划验收的实现偏差，且都集中在阶段 7/8 的 TUI 执行动作编排与结果页合同上。另外，计划里勾选为已通过的 `pnpm test:unit` / `pnpm test:integration`，在当前仓库直接执行时都没有稳定通过。

## 主要问题

### 1. 高：`所有平台` 批量写动作遇到首个失败目标就中止，没有实现计划要求的“整批执行后按平台汇总结果”

计划在阶段 7 明确要求：`所有平台` 展开后，普通批量动作应“一次汇总确认、按平台执行、按平台展示结果”，见 `docs/dev/plans/aw-tui-ux-optimization-plan.md:365-378`。

当前实现里，多平台执行仍然是简单串行调用，过程中没有对单个 target 的失败做收集和续跑：

- `packages/cli/src/commands/console.ts:1297-1317` 的安装/升级批量流程，任一 `installCommand()` / `upgradeCommand()` 抛错都会直接跳出循环。
- `packages/cli/src/commands/console.ts:1381-1409` 的卸载批量流程同样没有 per-target 容错。
- `packages/cli/src/commands/console.ts:1443-1488`、`1491-1510`、`1518-1532` 的清理、修复、重装也都是同样模式。
- 同时，破坏性动作的确认只看 `firstAction`，见 `packages/cli/src/commands/console.ts:1694-1704`，并不会把最终批量 target 列表作为一次确认页呈现出来。

这会带来两个直接后果：

- 批量操作无法满足“按平台执行、按平台展示结果”的合同，一旦前一个平台失败，后续平台根本不会执行。
- 用户拿不到整批 target 的最终确认与整批结果摘要，和计划中的批量编排语义不一致。

现有测试只覆盖了批量成功路径和取消路径，例如 `packages/cli/tests/unit/console.test.ts:619-716`、`984-1063`，没有覆盖多 target 中途失败后的继续执行和结果汇总。

### 2. 高：多类写动作没有真正进入结果页；`cleanup` 成功后展示的还是“计划”而不是“实际结果”

阶段 7 和阶段 8 明确要求统一写动作结果页合同，并要求结果以短摘要或结果页展示，见：

- `docs/dev/plans/aw-tui-ux-optimization-plan.md:372-378`
- `docs/dev/plans/aw-tui-ux-optimization-plan.md:422-423`

当前实现只有安装、升级、卸载、配置、重新应用配置走了 `showResultPage()`。以下动作成功后只是 `renderView()` 一次，然后马上返回 reload：

- `packages/cli/src/commands/console.ts:1487-1488` 清理
- `packages/cli/src/commands/console.ts:1509-1510` 修复
- `packages/cli/src/commands/console.ts:1531-1532` 重装
- `packages/cli/src/commands/console.ts:1546-1547` 认领
- `packages/cli/src/commands/console.ts:1561-1562` 接管共享触发策略

这意味着这些结果页既没有后续操作入口，也很容易在 controller reload 后被下一屏覆盖掉，不符合“完成后显示短摘要/结果页”的计划语义。

`cleanup` 还有更具体的偏差：执行成功后仍然调用 `renderCleanupPlanLines(result.payload)`，见 `packages/cli/src/commands/console.ts:1473-1484`。但这个 helper 只渲染 `plannedRemovals`、`wouldBackups`、`blockingReasons` 等计划字段，见 `packages/cli/src/commands/console.ts:1412-1431`，完全没有消费 `actualRemovals`、`actualBackups`、`skippedItems`、`remainingItems`。

这和阶段 2 对 `cleanup --force` 结果输出的要求直接不一致：计划要求执行结果区分“实际已删除项、实际备份项、跳过项、未清项和阻断原因”，见 `docs/dev/plans/aw-tui-ux-optimization-plan.md:158-159`。

现有测试也没有覆盖这部分结果合同。`packages/cli/tests/unit/console.test.ts:927-981` 只覆盖了 cleanup 风险页取消；`984-1063` 只校验了 `force/removeConfig` 传参，没有断言 cleanup 成功后的结果页内容。

### 3. 中：失败结果页的 `诊断` 入口只对 `abnormal` 状态开放，达不到“任一失败目标都能直接诊断”的要求

阶段 7 的结果页合同要求：“任一失败目标都必须提供可直接进入 `诊断` 的入口，并保留足够 target 信息”，见 `docs/dev/plans/aw-tui-ux-optimization-plan.md:377`、`402`。阶段 8 也再次要求结果页能按失败 target 展示诊断入口，见 `docs/dev/plans/aw-tui-ux-optimization-plan.md:423`、`439`。

但当前结果页诊断入口是按 `location.status === 'abnormal'` 过滤出来的，见 `packages/cli/src/commands/console.ts:274-285`。失败分支虽然统一走 `showResultPage()`，见 `packages/cli/src/commands/console.ts:1767-1778`，但如果命令失败后状态仍是 `notInstalled`、`installed` 或 `upgradeAvailable`，结果页就不会出现诊断入口。

这会漏掉至少两类失败：

- 安装/升级在只读 preflight 或执行早期失败，但状态还没投影成 `abnormal`
- 一些 direct command 失败后，reload 后的状态仍然不是 `abnormal`

现有测试只验证了“异常 target 会出现诊断入口”，见 `packages/cli/tests/unit/console.test.ts:1154-1175`，没有覆盖“失败但未投影为 abnormal”这一类结果页。

## 计划对照

### 已按计划落地的部分

- 阶段 1-4 的状态语义、reason code、`status --json.consoleItems` V2、console/model 拆层基本到位。
- 阶段 2 的 direct CLI 合同基本到位：`uninstall --force` 已移除，`cleanup --plan`、`--remove-config`、`cleanupPlanSchemaVersion: 1` 已落地。
- 阶段 3 的 scope 互斥预检已经接入 `install` / `upgrade` / `reinstall` / `repair`，并且位置在 required config 之前。
- 阶段 5-6 的首页、详情、状态/诊断结构化页面整体方向与计划一致。
- 阶段 9 的 README、公开文档和 `.agents/skills/create-agent-workflows-plugin/` 也已同步更新。

### 仍未满足计划验收的部分

- 阶段 7 的“`所有平台` 一次汇总确认、按平台执行、按平台展示结果”没有完整实现。
- 阶段 7 的“统一写动作结果页合同”没有覆盖清理、修复、重装、认领、接管共享触发策略。
- 阶段 7/8 的“任一失败目标都必须提供诊断入口”没有严格满足。

## 测试覆盖评估

### 计划内测试文件是否实现

计划列出的关键测试文件都已经存在并有对应新增/改动，包括：

- `packages/cli/tests/unit/cleanup-command.test.ts`
- `packages/cli/tests/unit/console-model.test.ts`
- `packages/cli/tests/unit/console.test.ts`
- `packages/cli/tests/unit/runtime.test.ts`
- `packages/cli/tests/unit/public-docs.test.ts`
- `packages/cli/tests/integration/console-entry.test.ts`
- `packages/cli/tests/integration/cli-entry-json-harness.test.ts`

从“有没有实现这些测试文件”这个层面看，答案是“已实现”。

### 是否完全覆盖计划变更内容

还不能算“完全覆盖”。

现有测试覆盖了很多关键 happy path 和合同边界，但至少还缺下面几类直接对应计划条目的用例：

- `所有平台` 批量写动作里，前一个 target 失败后后续 target 仍继续执行，并最终按平台汇总结果。
- 破坏性批量动作的最终确认页需要展示完整 target 集，而不是只复用第一个 target 的确认文案。
- `cleanup` 成功后的结果页应展示实际删除/备份/未清项，而不是继续展示 plan 语义。
- 修复、重装、认领、接管成功后应进入统一结果页，而不是只渲染一屏后立即 reload。
- 失败结果页在 target 未投影成 `abnormal` 时，仍然能进入对应 target 的诊断页。

## 测试执行情况

本次 review 额外执行了计划要求的回归命令：

- `pnpm test:unit`
- `pnpm test:integration`

结果：

- `pnpm test:unit` 当前未稳定通过，失败在 `tests/unit/marketplace.test.ts > uses the staged final manifest to filter platform marketplaces`，表现为 5 秒超时。
- `pnpm test:integration` 当前未稳定通过，失败在 `tests/integration/codex-explore-plugin.test.ts > refreshes legacy dual-healthy user and current-project Codex dynamic skills on user config writes and syncs accepted digests`，同样表现为 5 秒超时。
- 两个失败用例在单独重跑时都能通过，说明这更像是全量执行时的时序/性能稳定性问题，而不是单点逻辑断言错误。

因此，阶段 9 里勾选的“`pnpm test:unit` 和 `pnpm test:integration` 通过”，在当前仓库状态下还不能算稳定满足。

## 总评

这轮实现离计划目标已经很近，尤其是 direct CLI 合同、状态模型和公开文档这几块完成度不错。但如果按“是否严格按计划完成”来判断，阶段 7/8 还存在实质性偏差，主要集中在：

- 批量执行编排
- 结果页合同
- 失败后诊断入口
- 全量测试稳定性

建议先补齐这几处，再把计划里的阶段 7/8/9 验收项标记为真正完成。
