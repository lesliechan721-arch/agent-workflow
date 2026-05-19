# `aw` TUI 体验返工后续执行交接记录

日期：2026-05-15
关联计划：`docs/dev/plans/aw-tui-ux-polish-followup-plan.md`
中止点：阶段 9 开始后提前暂停

## 当前进度

- 阶段 1-5：本轮开始前已完成。
- 阶段 6：已实现并验收，计划 todo 已更新。
- 阶段 7A：已实现并验收，计划 todo 已更新。
- 阶段 7B：已实现并验收，计划 todo 已更新。
- 阶段 8：已实现并验收，计划 todo 已更新。
- 阶段 9：Mendel 子代理已开始铺垫，但未形成闭环，未验收，计划 todo 保持未完成。
- 阶段 10：未开始。

## 已关闭子代理

- Planck：阶段 6，已交付并关闭。
- Kepler：阶段 7A，已交付并关闭。
- Dewey：阶段 7B，已交付并关闭。
- Euler：阶段 8，已交付并关闭。
- Mendel：阶段 9，收到提前中止指令后停止实现，提交交接摘要，已关闭。

## 已验收测试

阶段 6 + 7A 合并验收：

```bash
pnpm --filter @yiliang/aw exec vitest run tests/unit/plugin-config.test.ts tests/unit/config-write.test.ts tests/unit/command-receipt.test.ts tests/unit/repair-command.test.ts tests/unit/console-wizard.test.ts tests/unit/console-model.test.ts tests/unit/console.test.ts tests/unit/status-dependencies.test.ts tests/integration/cli-entry-json-harness.test.ts tests/integration/plugin-lifecycle-command.test.ts tests/integration/console-entry.test.ts tests/integration/cli-entry.test.ts
```

结果：12 个测试文件、181 个用例通过。

阶段 7A 补跑计划列出的投影测试：

```bash
pnpm --filter @yiliang/aw exec vitest run tests/unit/install-state-status-projection.test.ts
```

结果：24 个用例通过。

阶段 7B 合并验收：

```bash
pnpm --filter @yiliang/aw exec vitest run tests/unit/plugin-config.test.ts tests/unit/config-write.test.ts tests/unit/command-receipt.test.ts tests/unit/repair-command.test.ts tests/unit/console-wizard.test.ts tests/unit/console-model.test.ts tests/unit/console.test.ts tests/unit/status-dependencies.test.ts tests/unit/install-state-status-projection.test.ts tests/integration/cli-entry-json-harness.test.ts tests/integration/plugin-lifecycle-command.test.ts tests/integration/console-entry.test.ts tests/integration/cli-entry.test.ts
```

结果：13 个测试文件、210 个用例通过。

阶段 8 指定验收：

```bash
pnpm --filter @yiliang/aw exec vitest run tests/unit/runtime.test.ts tests/unit/console.test.ts tests/unit/console-wizard.test.ts tests/unit/command-receipt.test.ts tests/unit/uninstall-command.test.ts tests/unit/cleanup-command.test.ts tests/integration/console-entry.test.ts tests/integration/console-duplicate-resolution.test.ts tests/unit/console-model.test.ts
```

结果：9 个测试文件、120 个用例通过。

阶段 6-8 合并回归：

```bash
pnpm --filter @yiliang/aw exec vitest run tests/unit/plugin-config.test.ts tests/unit/config-write.test.ts tests/unit/command-receipt.test.ts tests/unit/repair-command.test.ts tests/unit/console-wizard.test.ts tests/unit/console-model.test.ts tests/unit/console.test.ts tests/unit/runtime.test.ts tests/unit/uninstall-command.test.ts tests/unit/cleanup-command.test.ts tests/unit/status-dependencies.test.ts tests/unit/install-state-status-projection.test.ts tests/integration/cli-entry-json-harness.test.ts tests/integration/plugin-lifecycle-command.test.ts tests/integration/console-entry.test.ts tests/integration/console-duplicate-resolution.test.ts tests/integration/cli-entry.test.ts
```

结果：17 个测试文件、254 个用例通过。

阶段 9 启动后未运行测试。

## 阶段 9 半成品

Mendel 只做了早期铺垫，尚未补测试，也没有形成配置页闭环。相关改动集中在以下文件：

- `packages/cli/src/commands/status.ts`
- `packages/cli/src/commands/console-model.ts`
- `packages/cli/src/utils/plugin-config-write.ts`
- `packages/cli/src/commands/console.ts`

已做铺垫：

- `status.ts`：`resolveConsoleConfigProjection()` 从只投影 built-in 字段，改成投影 `resolveConfigReadV2()` 的全部 `fields`。
- `console-model.ts`：`buildSummaryFeatures()` 增加 `configProjection` 判断；legacy config placeholder 增加 `configure` feature，并把详情页功能菜单接到 summary features。
- `plugin-config-write.ts`：新增 `replayBuiltInConfigRuntime()`，用于后续不修改 config store 的 built-in runtime 重放。
- `console.ts`：增加阶段 9 后续需要的 import、`ConsoleRecentResult.summaryLines`、`ConsoleConfigTarget`、`ConsoleConfigWriteGroup`，并让最近结果在没有 target result 时可显示 `summaryLines`。

未完成：

- 配置 target 解析。
- 配置目标选择页。
- 配置管理页。
- 作用层切换。
- 字段更新、清空、整层重置。
- store-only 查看和清理。
- `应用` / `重新应用配置`。
- 保存后 per-target 最近结果展示。
- 阶段 9 测试。

## 当前风险

- `console.ts` 有不少新增 import、类型和 helper 铺垫尚未接入主流程，后续直接跑类型检查或测试可能出现 unused import/type 或行为断言失败。
- `console-model.ts` 让 legacy placeholder 多出 `configure` feature，可能影响现有 console model 断言。
- `status.ts` 扩大 `summary.config` 投影范围，可能影响 `status --json` 和 `consoleItems` 结构断言。
- `replayBuiltInConfigRuntime()` 尚未接入 console 流程，也未测试 no-op 和 managed target 返回结果。
- 阶段 9 不应标记完成；继续前应先确认是否保留 Mendel 的铺垫。

## 建议恢复步骤

1. 先查看阶段 9 半成品 diff：

```bash
git diff -- packages/cli/src/commands/status.ts packages/cli/src/commands/console-model.ts packages/cli/src/utils/plugin-config-write.ts packages/cli/src/commands/console.ts
```

2. 决定保留还是回退 Mendel 的铺垫。若要最快回到已验收阶段 8 的稳定状态，优先考虑回退上述 4 个文件中属于阶段 9 的半成品改动；若沿当前方向继续，先补齐 `console.ts` 主流程。

3. 阶段 9 继续时先补测试，优先覆盖：

- legacy placeholder 详情页有 `配置` 入口。
- 没有普通 schema / built-in 字段的未安装插件不显示预配置入口。
- `status.ts` 投影扩展后 `summary.config` 包含普通字段。
- `replayBuiltInConfigRuntime()` 对无 built-in 字段插件返回空数组。
- 配置 target 选择不会静默挑选多个 target 中的一个。

4. 再按顺序实现：

- `resolveConfigTargets()`。
- 配置目标选择页。
- store-only 页面。
- 配置页只读展示和单字段更新。
- 清空和整层重置。
- `应用` / `重新应用配置`。
- 最近结果和 per-target 展示。

## 当前工作区备注

- 计划文档已经更新到阶段 8 已验收。
- 阶段 9 相关 todo 未勾选。
- `docs/dev/reviews/aw-tui-ux-polish-followup-plan-review.md` 和 `docs/dev/reviews/aw-tui-ux-polish-followup-review.md` 是本轮开始时已存在的未跟踪文件，本记录未处理它们。
